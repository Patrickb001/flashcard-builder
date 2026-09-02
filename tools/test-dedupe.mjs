import fs from 'node:fs';
import { dedupeCards } from '../src/lib/cardValidation.ts';
import { selectQuestions } from '../src/lib/quizSelection.ts';
import { hasConflictingNumbers, overlapRatio } from '../src/lib/textUtils.ts';

/**
 * Near-duplicate removal, for cards and for the questions drawn from them.
 *
 *   node --experimental-strip-types --loader ./tools/ts-ext-hooks.mjs tools/test-dedupe.mjs
 *
 * Pure — no model call. The fixture deck is a real one that restates itself in
 * several places, which is what this exists to catch; the pairs asserted below
 * were found by reading it, not by running the detector over it.
 */

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`}`
  );
}

const deck = JSON.parse(fs.readFileSync('tools/fixtures/react-effects-cards.json', 'utf8'));
const byId = new Map(deck.map((c) => [c.id, c]));
const card = (id) => ({ ...byId.get(id), include: true });

console.log('\nSIMILARITY');
// The pairs that motivated this, read out of the deck by hand.
check(
  'c10/c53 fronts score as the same question',
  overlapRatio(byId.get('c10').front, byId.get('c53').front) >= 0.5,
  true
);
check(
  'c21/c46 fronts score as the same question',
  overlapRatio(byId.get('c21').front, byId.get('c46').front) >= 0.5,
  true
);
check(
  'c48/c59 fronts score as the same question',
  overlapRatio(byId.get('c48').front, byId.get('c59').front) >= 0.5,
  true
);
check(
  'c11 and c35 are different questions about measuring',
  overlapRatio(byId.get('c11').front, byId.get('c35').front) >= 0.75,
  false
);
// Measured, and the reason the back has to agree before anything is dropped:
// two genuinely different cards about fetching score as high on their fronts as
// a real duplicate pair does. Front similarity alone is not evidence.
check(
  'c5 and c13 score high on fronts despite being different cards',
  overlapRatio(byId.get('c5').front, byId.get('c13').front) >= 0.75,
  true
);

// Two answers differing only by a figure are as similar as words can measure —
// 0.8 — which is exactly why word overlap alone must not decide. The guard is
// separate and decisive. This is the case that matters most to get right: it is
// the two halves of a distinction a student is examined on.
check(
  'differing figures still read as similar words',
  overlapRatio('4 days, with observable change in functioning', '7 days, with observable change in functioning') >= 0.6,
  true
);
check(
  'but conflicting numbers are detected',
  hasConflictingNumbers('4 days, with observable change', '7 days, with observable change'),
  true
);
check(
  'a shared figure is not a conflict',
  hasConflictingNumbers('0.6-1.2 mEq/L is therapeutic', 'therapeutic range is 0.6-1.2 mEq/L'),
  false
);
check(
  'one side quoting no figure is not a conflict',
  hasConflictingNumbers('lasts 7 days', 'lasts about a week'),
  false
);

console.log('\nCARD DE-DUPLICATION');
check('an exact repeat is dropped', dedupeCards([card('c10'), card('c10')]).length, 1);

// A restatement that reuses the wording — the shape this actually catches.
// Both halves have to carry enough words to be judged at all.
const restated = {
  ...byId.get('c14'),
  id: 'dup',
  front: 'Why does changing the `key` prop on a component cause React to reset its state?',
  back: 'React preserves state for the same component in the same spot, so a different key makes React treat it as a different component and reset the state of it and its children.',
  include: true,
};
check('a reworded near-copy is dropped', dedupeCards([card('c14'), restated]).length, 1);
check('the first of a pair is the one kept', dedupeCards([card('c14'), restated])[0].id, 'c14');

// The short-text guard, which six of nine cards on a golden page fell foul of.
// "What is function?" carries one content word and matched everything.
const terse = { id: 't1', front: 'What is function?', back: 'A block of code that performs a specific task and can be reused.', include: true };
const printed = { id: 't2', front: 'Built-in functions — what does this C++ program print?', back: 'Square Root: 5', include: true };
check('a one-word front does not swallow other cards', dedupeCards([terse, printed]).length, 2);

// Documented limitation, asserted so it is noticed if it ever changes. These
// two say the same thing in different words and both survive; the second chance
// is selection-time de-duplication below.
check(
  'a restatement with different vocabulary is NOT caught here',
  dedupeCards([card('c10'), card('c53')]).length,
  2
);

// The whole point of requiring BOTH halves: cards that ask similar questions
// with genuinely different answers are not duplicates and must survive.
check(
  'same topic, different answers, both survive',
  dedupeCards([card('c5'), card('c13'), card('c17'), card('c66')]).length,
  4
);
check(
  'the measuring cluster survives intact',
  dedupeCards([card('c11'), card('c12'), card('c35'), card('c57'), card('c69')]).length,
  5
);
// The documented limitation, at deck scale. Every restatement in this deck is
// worded differently, so card de-duplication removes nothing from it. That is
// the honest result, not a passing grade — it is why selection-time
// de-duplication below exists.
check(
  'this deck’s restatements all survive card de-duplication',
  dedupeCards(deck.map((c) => ({ ...c, include: true }))).length,
  deck.length
);

console.log('\nQUESTION SELECTION');
const q = (id, stem, correct, timesAsked = 0) => ({
  id,
  deckId: 'd1',
  cardId: id,
  stem,
  correctAnswer: correct,
  distractors: ['x', 'y', 'z'],
  explanation: 'e',
  sourceLabel: 'Page 1',
  cardHash: 'h',
  createdAt: 1,
  timesAsked,
  lastAskedAt: null,
  timesCorrect: 0,
});

const twins = [
  q('a', 'What should you consider when synchronizing state variables across components?', 'Lifting state up'),
  q('b', 'What general rule applies when keeping two different state variables synchronized?', 'Lift the state up'),
  q('c', 'How do you cache an expensive calculation in React?', 'Wrap it in useMemo'),
];
const drawn = selectQuestions(twins, 3);
check('two questions that mean the same are not both drawn', drawn.length, 2);
check('the distinct question survives', drawn.some((d) => d.id === 'c'), true);

// Similar stems with different answers are different questions and must both run.
const siblings = [
  q('a', 'What is the therapeutic serum level range for lithium?', '0.6-1.2 mEq/L'),
  q('b', 'What is the serum level range at which lithium becomes toxic?', 'Above 1.5 mEq/L'),
];
check('similar stems with different answers both survive', selectQuestions(siblings, 2).length, 2);

// A one-word answer is a subset of every answer containing that word, so it
// scores 1.00 against all of them. Without a minimum size these two — different
// phases, different questions — collapsed to one, which is the same trap the
// card thresholds guard against and sharper here, since options are capped at
// fifteen words and the good ones are far shorter.
const shortAnswers = [
  q('a', 'Which phase does React use to compare element trees?', 'Reconciliation'),
  q('b', 'Which phase does React use to commit changes to the DOM?', 'Reconciliation phase'),
];
check('a one-word answer does not swallow another question', selectQuestions(shortAnswers, 2).length, 2);

// The figure that separates two questions sits in the stem as often as in the
// answer, so both halves are checked — card de-duplication has always done this.
const numberedStems = [
  q('a', 'What does the retry policy do after 2 failed attempts?', 'It gives up and reports the error'),
  q('b', 'What does the retry policy do after 5 failed attempts?', 'It gives up and reports the error'),
];
check('a figure only in the stem still separates two questions', selectQuestions(numberedStems, 2).length, 2);

// A pool that is nothing but one question restated must still yield a test.
const allSame = [
  q('a', 'What should you consider when synchronizing state variables across components?', 'Lifting state up'),
  q('b', 'What general rule applies when keeping two different state variables synchronized?', 'Lift the state up'),
];
check('a pool of pure duplicates still yields a test', selectQuestions(allSame, 2).length > 0, true);

// The existing guarantees must not have moved. The stems have to be genuinely
// different for this to test selection rather than de-duplication — an earlier
// version used "Distinct question number N", which every stopword and the
// length filter reduce to the same three words, so the whole pool collapsed to
// one question and the selection assertions failed. That was the fixture being
// wrong, but it is also how the missing-numbers bug above was found.
const TOPICS = [
  'closures', 'hoisting', 'promises', 'generators', 'prototypes', 'currying',
  'debouncing', 'throttling', 'memoization', 'recursion', 'immutability',
  'destructuring', 'modules', 'iterators', 'proxies', 'symbols', 'reflection',
  'coercion', 'scoping', 'shadowing', 'tagging', 'streaming', 'batching',
  'hydration', 'reconciliation', 'suspense', 'portals', 'refs', 'context', 'reducers',
];
const pool = TOPICS.map((topic, i) =>
  q(`q${i}`, `How does ${topic} behave in JavaScript?`, `The defining behaviour of ${topic}`)
);
check('draws the number asked for', selectQuestions(pool, 10).length, 10);
check('never draws the same question twice', new Set(selectQuestions(pool, 30).map((x) => x.id)).size, 30);
check('clamps a request larger than the pool', selectQuestions(pool, 100).length, 30);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
