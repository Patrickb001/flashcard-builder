import fs from 'node:fs';
import { parseVignetteResponse, parseQuizResponse } from '../src/lib/quizPrompt.ts';
import { generateQuestionsForCards, hashCard } from '../src/lib/quizGenerator.ts';
import { styleOf } from '../src/types.ts';

/**
 * The PANCE-style question path.
 *
 *   node --experimental-strip-types --import ./tools/register.mjs tools/test-vignette.mjs
 *
 * Part 1 is pure and always runs. Part 2 calls the real model and runs only
 * when a key is present, because the thing that actually matters here — whether
 * the vignette invented clinical facts the deck never taught — is not something
 * an assertion can decide. It is printed for reading instead.
 */

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`}`
  );
}

// ---------------------------------------------------------------------------
// Part 1 — the parser
// ---------------------------------------------------------------------------

console.log('\nPARSER');

const four = (extra = '') =>
  `[{"id":"q1","vignette":"A 27-year-old woman presents with 6 weeks of low mood.","stem":"Which of the following is the most likely diagnosis?","correct":"Bipolar II disorder","distractors":["Major depressive disorder","Bipolar I disorder","Cyclothymia","Persistent depressive disorder"],"explanation":"A past hypomanic episode with a major depressive episode defines bipolar II."${extra}}]`;

check('a five-option item parses', parseVignetteResponse(four()).length, 1);
check(
  'it keeps exactly four distractors',
  parseVignetteResponse(four())[0].distractors.length,
  4
);
check('the vignette survives', parseVignetteResponse(four())[0].vignette.startsWith('A 27-year-old'), true);

// Three distractors is a recall question, not a board item — it must not pass
// the vignette parser, or a short item reaches the test with four options.
const three =
  '[{"id":"q1","vignette":"x","stem":"s","correct":"a","distractors":["b","c","d"],"explanation":"e"}]';
check('three distractors is rejected for a board item', parseVignetteResponse(three).length, 0);
check('but is still fine as a recall question', parseQuizResponse(three).length, 1);

// The escape hatch: a bare fact gets a direct question and no patient.
const hatch =
  '[{"id":"q1","vignette":"","stem":"Which of the following is the therapeutic range for lithium?","correct":"0.6-1.2 mEq/L","distractors":["0.2-0.6 mEq/L","1.5-2.0 mEq/L","2.0-2.5 mEq/L","0.1-0.4 mEq/L"],"explanation":"Lithium is dosed to 0.6-1.2 mEq/L."}]';
check('an empty vignette is accepted', parseVignetteResponse(hatch).length, 1);
check('and comes back undefined, not ""', parseVignetteResponse(hatch)[0].vignette, undefined);

// A duplicated distractor leaves four options, which is a board item short one.
const dupe =
  '[{"id":"q1","vignette":"x","stem":"s","correct":"a","distractors":["b","b","c","d"],"explanation":"e"}]';
check('a repeated distractor drops the item', parseVignetteResponse(dupe).length, 0);

// Truncation matters more here than anywhere: a vignette batch sits closest to
// the ceiling. The complete items must survive a reply that never closed.
const cut = `${four().slice(0, -1)},{"id":"q2","vignette":"A 34-year-old man`;
check('a truncated reply keeps its complete items', parseVignetteResponse(cut).length, 1);

// ---------------------------------------------------------------------------
// Part 2 — back-compatibility
//
// Every question written before styles existed has no style field. If those
// read as anything but "recall", the whole stored pool of every existing deck
// drops out of the test and the app looks like it lost the user's questions.
// ---------------------------------------------------------------------------

console.log('\nBACK-COMPAT');

const legacy = { id: 'x', cardId: 'c1' }; // as stored before this feature
check('a styleless question reads as recall', styleOf(legacy), 'recall');
check('an explicit recall question reads as recall', styleOf({ style: 'recall' }), 'recall');
check('a vignette reads as a vignette', styleOf({ style: 'vignette' }), 'vignette');

const mixedPool = [legacy, { id: 'y', style: 'vignette' }, { id: 'z', style: 'recall' }];
check(
  'the recall lens keeps the legacy question',
  mixedPool.filter((q) => styleOf(q) === 'recall').map((q) => q.id),
  ['x', 'z']
);
check(
  'the vignette lens excludes it',
  mixedPool.filter((q) => styleOf(q) === 'vignette').map((q) => q.id),
  ['y']
);

// The "cards without a question" key. Keyed on cardId alone, one style's
// question hides the other's absence and the top-up button offers the wrong set.
const poolKey = (q) => `${q.cardId}:${styleOf(q)}`;
check(
  'the same card in two styles gives two keys',
  new Set([poolKey({ cardId: 'c1' }), poolKey({ cardId: 'c1', style: 'vignette' })]).size,
  2
);

// ---------------------------------------------------------------------------
// Part 3 — real generation
// ---------------------------------------------------------------------------

function readKeyFromEnvFile() {
  try {
    return fs.readFileSync('.env', 'utf8').match(/ANTHROPIC_API_KEY=(.+)/)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

const key = process.env.ANTHROPIC_API_KEY ?? readKeyFromEnvFile();
if (!key) {
  console.log('\nGENERATION skipped — set ANTHROPIC_API_KEY to run it.');
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

console.log('\nGENERATION');

const cards = JSON.parse(
  fs.readFileSync(process.argv[2] ?? 'tools/fixtures/pance-cards.json', 'utf8')
);

const result = await generateQuestionsForCards(cards, cards, 'Mood disorders', {
  mode: 'byok',
  apiKey: key,
}, { style: 'vignette' });

const missed = new Set(result.failedCardIds);
console.log(
  `  ${result.questions.length} of ${cards.length} cards got a question ` +
    `(${result.totalBatches - result.failedBatches}/${result.totalBatches} batches, ${result.truncatedBatches} truncated)\n`
);

const byId = new Map(cards.map((c) => [c.id, c]));
let withVignette = 0;

for (const q of result.questions) {
  const card = byId.get(q.cardId);
  if (q.vignette) {
    withVignette++;
    console.log(`  ${q.vignette}`);
  } else {
    console.log('  (direct question — no scenario)');
  }
  console.log(`  Q: ${q.stem}`);
  console.log(`     * ${q.correctAnswer}`);
  for (const d of q.distractors) console.log(`       ${d}`);
  console.log(`     why: ${q.explanation}`);
  console.log(`     card: ${card?.front} -> ${card?.back}\n`);
}

console.log('GENERATION ASSERTIONS');
check(
  'every question maps to a real card',
  result.questions.every((q) => byId.has(q.cardId)),
  true
);
check(
  'every question has exactly four distractors',
  result.questions.every((q) => q.distractors.length === 4),
  true
);
check(
  'no option is repeated within a question',
  result.questions.every(
    (q) => new Set([q.correctAnswer, ...q.distractors].map((o) => o.toLowerCase().trim())).size === 5
  ),
  true
);
check(
  'every explanation is non-empty',
  result.questions.every((q) => q.explanation.trim().length > 0),
  true
);
check(
  'every question is stamped as a vignette',
  result.questions.every((q) => q.style === 'vignette'),
  true
);
check(
  'every card is either answered or reported',
  result.questions.length + missed.size,
  cards.length
);
check(
  'the hash matches the source card',
  result.questions.every((q) => q.cardHash === hashCard(byId.get(q.cardId))),
  true
);
// Not all-or-nothing on purpose: bare-fact cards SHOULD take the escape hatch,
// but a run where nothing got a scenario means the vignette half is not working.
check('some questions carry a scenario', withVignette > 0, true);

console.log(
  '\n  Read the vignettes above: no vital sign, lab value or finding may appear\n' +
    '  that the fixture cards do not support, and no wrong answer may also be true.'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
