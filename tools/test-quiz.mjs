import fs from 'node:fs';
import { parseQuizResponse } from '../src/lib/quizPrompt.ts';
import { selectQuestions, prepareQuestion } from '../src/lib/quizSelection.ts';
import { generateQuestionsForCards, hashCard } from '../src/lib/quizGenerator.ts';

/**
 * Exercises the test-question pipeline without a browser.
 *
 *   node --experimental-strip-types --import ./tools/register.mjs \
 *     tools/test-quiz.mjs
 *
 * Parts 1 and 2 are pure and always run. Part 3 calls the real model and runs
 * only when a key is present, because the thing it checks — whether the wrong
 * answers are actually wrong — is not something an assertion can decide.
 */

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`}`);
}

// ---------------------------------------------------------------------------
// Part 1 — the parser
// ---------------------------------------------------------------------------

console.log('\nPARSER');

const wellFormed = JSON.stringify([
  { id: 'q1', stem: 'What does a for loop do?', correct: 'Repeats a block a set number of times', distractors: ['Declares a variable', 'Defines a function', 'Imports a module'], explanation: 'A for loop repeats its body a known number of times.' },
]);

check('a bare array parses', parseQuizResponse(wellFormed).length, 1);
check('a fenced array parses', parseQuizResponse('```json\n' + wellFormed + '\n```').length, 1);
check('prose around the array is ignored', parseQuizResponse('Here you go:\n' + wellFormed + '\nHope that helps.').length, 1);
check('non-JSON yields nothing', parseQuizResponse('I could not do that.').length, 0);
check('an empty array yields nothing', parseQuizResponse('[]').length, 0);

// The case the salvage pass exists for: a reply cut off mid-object.
const truncated =
  '[{"id":"q1","stem":"A?","correct":"Right","distractors":["W1","W2","W3"],"explanation":"Because."},' +
  '{"id":"q2","stem":"B?","correct":"Right2","distractors":["X1","X2","X3"],"explanation":"Because."},' +
  '{"id":"q3","stem":"C?","correct":"Rig';
check('a truncated reply keeps its complete questions', parseQuizResponse(truncated).length, 2);

check(
  'two distractors is not enough',
  parseQuizResponse('[{"id":"q1","stem":"A?","correct":"R","distractors":["W1","W2"],"explanation":"B."}]').length,
  0
);
check(
  'a distractor repeating the answer is rejected',
  parseQuizResponse('[{"id":"q1","stem":"A?","correct":"Red","distractors":["  red  ","W2","W3"],"explanation":"B."}]').length,
  0
);
check(
  'two identical distractors are rejected',
  parseQuizResponse('[{"id":"q1","stem":"A?","correct":"R","distractors":["Same","same!","W3"],"explanation":"B."}]').length,
  0
);
check(
  'a missing explanation is rejected',
  parseQuizResponse('[{"id":"q1","stem":"A?","correct":"R","distractors":["W1","W2","W3"],"explanation":"  "}]').length,
  0
);
check(
  'a repeated id is only answered once',
  parseQuizResponse('[{"id":"q1","stem":"A?","correct":"R","distractors":["W1","W2","W3"],"explanation":"B."},{"id":"q1","stem":"A2?","correct":"R2","distractors":["X1","X2","X3"],"explanation":"B."}]').length,
  1
);

// ---------------------------------------------------------------------------
// Part 2 — selection
// ---------------------------------------------------------------------------

console.log('\nSELECTION');

const pool = Array.from({ length: 30 }, (_, i) => ({
  id: `id-${i}`,
  deckId: 'd',
  cardId: `c-${i}`,
  stem: `Q${i}`,
  correctAnswer: `A${i}`,
  distractors: ['x', 'y', 'z'],
  explanation: 'e',
  sourceLabel: 'Section 1',
  cardHash: 'h',
  createdAt: i,
  timesAsked: 0,
  lastAskedAt: null,
  timesCorrect: 0,
}));

const draw = selectQuestions(pool, 10);
check('draws the number asked for', draw.length, 10);
check('never draws the same question twice', new Set(draw.map((q) => q.id)).size, 10);
check('clamps a request larger than the pool', selectQuestions(pool, 100).length, 30);
check('an empty pool draws nothing', selectQuestions([], 5).length, 0);

// The guarantee that matters: three tests of ten over a pool of thirty should
// cover the whole pool exactly once before anything is repeated.
const counters = new Map(pool.map((q) => [q.id, 0]));
const asked = [];
let working = pool.map((q) => ({ ...q }));
for (let round = 0; round < 3; round++) {
  const picked = selectQuestions(working, 10);
  for (const q of picked) {
    counters.set(q.id, counters.get(q.id) + 1);
    asked.push(q.id);
  }
  working = working.map((q) => ({ ...q, timesAsked: counters.get(q.id) }));
}
check('three rounds of ten cover all thirty', new Set(asked).size, 30);
check('nothing is asked twice before everything is asked once', [...new Set(counters.values())], [1]);

// Two draws from the same starting state must differ, or the shuffle is dead.
let differed = false;
for (let i = 0; i < 20 && !differed; i++) {
  const a = selectQuestions(pool, 10).map((q) => q.id).join();
  const b = selectQuestions(pool, 10).map((q) => q.id).join();
  if (a !== b) differed = true;
}
check('two draws from the same pool differ', differed, true);

// Option order must not be stored, or a model that answers first every time
// would put the answer in slot A for every sitting.
const question = pool[0];
const positions = new Set();
for (let i = 0; i < 40; i++) positions.add(prepareQuestion(question).correctIndex);
check('the answer moves between option slots', positions.size > 1, true);
check('every option is present exactly once', prepareQuestion(question).options.length, 4);

// ---------------------------------------------------------------------------
// Part 3 — real generation
// ---------------------------------------------------------------------------

const key = process.env.ANTHROPIC_API_KEY ?? readKeyFromEnvFile();

function readKeyFromEnvFile() {
  try {
    return fs.readFileSync('.env', 'utf8').match(/ANTHROPIC_API_KEY=(.+)/)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

if (!key) {
  console.log('\nGENERATION skipped — set ANTHROPIC_API_KEY to run it.');
} else {
  console.log('\nGENERATION');

  const cards = JSON.parse(fs.readFileSync(process.argv[2] ?? 'tools/fixtures/quiz-cards.json', 'utf8'));
  const result = await generateQuestionsForCards(cards, cards, 'Programming basics', {
    mode: 'byok',
    apiKey: key,
  });

  console.log(
    `  ${result.questions.length} of ${cards.length} cards got a question` +
      ` (${result.totalBatches - result.failedBatches}/${result.totalBatches} batches)`
  );
  if (result.firstError) console.log(`  !! ${result.firstError}`);

  for (const q of result.questions) {
    const card = cards.find((c) => c.id === q.cardId);
    console.log(`\n  Q: ${q.stem}`);
    if (q.stemCode) console.log(`     [snippet: ${q.stemCode.language ?? '?'}, ${q.stemCode.text.length} chars]`);
    console.log(`     * ${q.correctAnswer}`);
    for (const d of q.distractors) console.log(`       ${d}`);
    console.log(`     why: ${q.explanation}`);
    console.log(`     card: ${card?.front} -> ${card?.back}`);
  }

  console.log('\nGENERATION ASSERTIONS');
  const cardIds = new Set(cards.map((c) => c.id));
  check('every question maps to a real card', result.questions.every((q) => cardIds.has(q.cardId)), true);
  check('every question has three distractors', result.questions.every((q) => q.distractors.length === 3), true);
  check(
    'no option is repeated within a question',
    result.questions.every((q) => new Set([q.correctAnswer, ...q.distractors].map((o) => o.toLowerCase().trim())).size === 4),
    true
  );
  check('every explanation is non-empty', result.questions.every((q) => q.explanation.trim().length > 0), true);
  check('every card is either answered or reported', result.questions.length + new Set(result.failedCardIds).size, cards.length);
  check('the hash matches the source card', result.questions.every((q) => q.cardHash === hashCard(cards.find((c) => c.id === q.cardId))), true);
  console.log('\n  Read the options above: no wrong answer may also be true.');
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} CHECK(S) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
