import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateQuestionsForCards } from '../src/lib/quizGenerator.ts';

/**
 * Does a recall question ever use an also-correct answer as a wrong answer?
 *
 *   node --experimental-strip-types --loader ./tools/ts-ext-hooks.mjs \
 *     tools/test-neighbour-context.mjs [before|after]
 *
 * Neighbours used to reach the model as bare answers, with no indication of the
 * question each one answered. That made rule 4 of the prompt — every wrong
 * answer must be unambiguously wrong — impossible to check for a deck that says
 * the same thing twice in different words. This deck does:
 *
 *   c10 "What general rule ... keep two different state variables synchronized?"
 *       -> "Try lifting state up instead of synchronizing two separate state variables."
 *   c53 "What should you consider when ... synchronize state variables across
 *        different components?"        -> "Consider lifting state up."
 *
 * If c53's answer is offered as a wrong answer to c10, the question has two right
 * answers and marks a student wrong for knowing the material. Neighbours now
 * carry their fronts so the model can notice; this is what says whether that
 * worked.
 *
 * The detector below looks for exactly that shape, and prints every hit so the
 * judgement can be read rather than taken on trust. Run it once before changing
 * the payload and prompt, once after, and compare.
 *
 * Its similarity functions are copies of the ones in textUtils, deliberately. It
 * is the instrument, and an instrument built out of the code under test cannot
 * report that code's blind spots — the two would agree that two cards are
 * different for precisely the reason both are wrong. Its stoplist also carries
 * deck-specific words ("react", "docs") that have no business in a shared
 * helper. Leave them apart.
 */

const LABEL = process.argv[2] ?? 'run';

/**
 * Where the two runs are written so they can be compared.
 *
 * Outside the repo by default — these are transcripts of one measurement, not
 * fixtures, and the point of the tool is that the before-run survives long
 * enough to diff against the after-run. Override with SCRATCH to put them
 * somewhere you will find them again.
 */
const OUT_DIR = process.env.SCRATCH ?? path.join(os.tmpdir(), 'flashcard-forge');

/**
 * The cards questions are written for.
 *
 * A quarter of the deck, chosen to cover every cluster where two cards say
 * nearly the same thing — the whole deck is still passed as deckCards, so the
 * neighbour lists are exactly what a full run would see. Generating for a
 * quarter costs a quarter and concentrates the hazard rather than diluting it.
 */
const TARGET_IDS = [
  // the two pairs that motivated this
  'c10', 'c53', // lifting state up
  'c21', 'c46', // resetting state via key
  // resetting state on prop change — a large, heavily overlapping cluster
  'c3', 'c14', 'c25', 'c65',
  // when not to use an Effect
  'c2', 'c4', 'c8', 'c44',
  // events vs Effects — c48 and c59 ask nearly the same question
  'c19', 'c28', 'c48', 'c59',
  // derived values and useMemo
  'c40', 'c52', 'c55', 'c62', 'c67',
  // measuring performance
  'c11', 'c35', 'c69',
];

const STOP = new Set([
  'what', 'when', 'where', 'which', 'that', 'this', 'those', 'these', 'with',
  'from', 'your', 'you', 'the', 'and', 'for', 'not', 'but', 'its', 'into',
  'does', 'doing', 'done', 'should', 'would', 'could', 'about', 'according',
  'react', 'docs', 'give', 'used', 'using', 'use', 'them', 'they', 'their',
  'instead', 'rather', 'than', 'inside', 'within', 'without', 'like', 'such',
]);

/**
 * Crude suffix stripping, applied until it stops changing the word.
 *
 * Needed because the pair this exists to catch says "synchronized" on one card
 * and "synchronize" on the other. Without it they are different tokens and the
 * two questions score as unrelated. Repeated rather than single-pass so
 * "variables" and "variable" land on the same stem instead of one stopping a
 * step short of the other.
 */
function stem(word) {
  let s = word;
  for (;;) {
    let next = s;
    for (const suffix of ['ing', 'ed', 'es', 's', 'e']) {
      if (s.endsWith(suffix) && s.length - suffix.length >= 4) {
        next = s.slice(0, -suffix.length);
        break;
      }
    }
    if (next === s) return s;
    s = next;
  }
}

/** Content words, for a crude same-meaning score. */
function words(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP.has(w))
      .map(stem)
  );
}

/**
 * Overlap coefficient — shared words over the SHORTER set.
 *
 * Jaccard was the obvious choice and is wrong here. "How do you reset the state
 * of an entire component tree?" is eleven words; the card it duplicates is
 * twenty-two. Dividing by the union punishes the short one for being short, and
 * scored the two motivating pairs at 0.25 — under any threshold that also
 * excluded unrelated cards. What is being asked is whether the shorter question
 * is contained in the longer, which is what this measures.
 */
function overlap(a, b) {
  const A = words(a);
  const B = words(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

/** A distractor is condensed, so an exact match against a card's back is too strict. */
const ANSWER_MATCH = 0.6;
/** Above this the two fronts are asking the same thing. */
const FRONT_MATCH = 0.5;

function readKeyFromEnvFile() {
  try {
    return fs.readFileSync('.env', 'utf8').match(/ANTHROPIC_API_KEY=(.+)/)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

const deck = JSON.parse(fs.readFileSync('tools/fixtures/react-effects-cards.json', 'utf8'));
const byId = new Map(deck.map((c) => [c.id, c]));
const targets = TARGET_IDS.map((id) => {
  const card = byId.get(id);
  if (!card) throw new Error(`TARGET_IDS names ${id}, which is not in the fixture`);
  return card;
});

// --------------------------------------------------------------------------
// The detector, checked against the known pair before it is trusted on output
// --------------------------------------------------------------------------

console.log('\nDETECTOR SELF-CHECK');
let selfCheckFailures = 0;
const expect = (label, actual, wanted) => {
  const ok = actual === wanted;
  if (!ok) selfCheckFailures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — got ${actual}, wanted ${wanted}`}`);
};

// The motivating pair must score as equivalent, or the detector cannot see the
// thing it exists to find.
expect(
  'c10/c53 fronts read as the same question',
  overlap(byId.get('c10').front, byId.get('c53').front) >= FRONT_MATCH,
  true
);
expect(
  'c21/c46 fronts read as the same question',
  overlap(byId.get('c21').front, byId.get('c46').front) >= FRONT_MATCH,
  true
);
// And two genuinely different questions must not.
expect(
  'c10 and c35 do not',
  overlap(byId.get('c10').front, byId.get('c35').front) >= FRONT_MATCH,
  false
);
expect(
  'c53 answer matches itself',
  overlap(byId.get('c53').back, 'Consider lifting state up') >= ANSWER_MATCH,
  true
);

if (selfCheckFailures > 0) {
  console.log(`\n${selfCheckFailures} self-check(s) failed — the thresholds need tuning first.`);
  process.exit(1);
}

// --------------------------------------------------------------------------
// Live generation
// --------------------------------------------------------------------------

const key = process.env.ANTHROPIC_API_KEY ?? readKeyFromEnvFile();
if (!key) {
  console.log('\nGENERATION skipped — set ANTHROPIC_API_KEY to run it.');
  process.exit(0);
}

console.log(`\nGENERATION (${LABEL}) — ${targets.length} targets, ${deck.length} cards as neighbours`);

const result = await generateQuestionsForCards(targets, deck, 'React Effects', {
  mode: 'byok',
  apiKey: key,
});

console.log(
  `  ${result.questions.length} of ${targets.length} written ` +
    `(${result.totalBatches - result.failedBatches}/${result.totalBatches} batches, ${result.truncatedBatches} truncated)`
);

/**
 * Every distractor that is another card's answer to an equivalent question.
 *
 * Two conditions, both required. The distractor has to actually be some other
 * card's answer — a wrong answer the model invented is not this bug — and that
 * card has to be asking the same thing as the card being tested, because a
 * sibling card's answer is a GOOD distractor when the questions differ. It is
 * only a defect when the two questions mean the same, since then both answers
 * are correct.
 */
const flags = [];
for (const q of result.questions) {
  const source = byId.get(q.cardId);
  if (!source) continue;

  for (const distractor of q.distractors) {
    for (const other of deck) {
      if (other.id === source.id) continue;
      // A two-word answer like "Set it during rendering." is contained in almost
      // any longer sentence about rendering, so it scored 1.00 against
      // distractors it had nothing to do with. The before-run's six flags
      // included two of those. Too short to judge means not judged.
      if (words(other.back).size < 4) continue;
      const answerScore = overlap(distractor, other.back);
      if (answerScore < ANSWER_MATCH) continue;
      const frontScore = overlap(source.front, other.front);
      if (frontScore < FRONT_MATCH) continue;
      flags.push({ question: q, source, other, distractor, answerScore, frontScore });
    }
  }
}

if (flags.length === 0) {
  console.log('\n  No distractor is another card’s answer to an equivalent question.');
} else {
  console.log(`\nFLAGGED — ${flags.length} also-correct distractor(s)\n`);
  for (const f of flags) {
    console.log(`  stem:       ${f.question.stem}`);
    console.log(`  answer:     ${f.question.correctAnswer}`);
    console.log(`  DISTRACTOR: ${f.distractor}`);
    console.log(`  ...is ${f.other.id}'s answer: ${f.other.back}`);
    console.log(`  ...to:      ${f.other.front}`);
    console.log(`  from card:  ${f.source.front}`);
    console.log(`  scores:     answer ${f.answerScore.toFixed(2)}, front ${f.frontScore.toFixed(2)}\n`);
  }
}

// Saved so the two runs are compared rather than remembered.
fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, `neighbour-${LABEL}.json`);
fs.writeFileSync(
  out,
  JSON.stringify(
    {
      label: LABEL,
      written: result.questions.length,
      targets: targets.length,
      flagged: flags.length,
      flags: flags.map((f) => ({
        sourceId: f.source.id,
        otherId: f.other.id,
        stem: f.question.stem,
        distractor: f.distractor,
        answerScore: Number(f.answerScore.toFixed(3)),
        frontScore: Number(f.frontScore.toFixed(3)),
      })),
      questions: result.questions.map((q) => ({
        cardId: q.cardId,
        stem: q.stem,
        correct: q.correctAnswer,
        distractors: q.distractors,
      })),
    },
    null,
    2
  ),
  'utf8'
);
console.log(`  written to ${out}`);
console.log(`\n${LABEL}: ${flags.length} flagged of ${result.questions.length} questions.`);
