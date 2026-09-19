import 'fake-indexeddb/auto';
import { openDB } from 'idb';

/**
 * The scheduling writes in db.ts, against an in-memory IndexedDB.
 *
 *   node --experimental-strip-types --import ./tools/register.mjs tools/test-srs-db.mjs
 *
 * fake-indexeddb checks behaviour — what gets written, what the index counts,
 * that a v4 database upgrades cleanly — not races. Races between tabs are
 * tools/idb-check.html's job, in a real browser.
 *
 * Step 1 builds a version-4 database by hand, shaped exactly as the previous
 * build left it, with one card already graded the old way (status only). Only
 * then is db.ts imported, so its open is a genuine 4 → 5 upgrade.
 */

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`}`
  );
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 0, 10, 9).getTime();

// ---------------------------------------------------------------------------
console.log('UPGRADE FROM VERSION 4');
// ---------------------------------------------------------------------------

const v4 = await openDB('flashcard-forge', 4, {
  upgrade(db) {
    db.createObjectStore('decks', { keyPath: 'id' }).createIndex('by-createdAt', 'createdAt');
    db.createObjectStore('flashcards', { keyPath: 'id' }).createIndex('by-deckId', 'deckId');
    const q = db.createObjectStore('testQuestions', { keyPath: 'id' });
    q.createIndex('by-deckId', 'deckId');
    q.createIndex('by-cardId', 'cardId');
    db.createObjectStore('folders', { keyPath: 'id' });
    db.createObjectStore('infographics', { keyPath: 'id' }).createIndex('by-deckId', 'deckId');
  },
});
const card = (id, extra = {}) => ({
  id, deckId: 'd1', front: `Q${id}`, back: `A${id}`, sourceLabel: 'Page 1',
  status: 'new', createdAt: 0, ...extra,
});
await v4.put('decks', { id: 'd1', name: 'Deck', sourceFileName: 'x.md', sourceType: 'md', createdAt: 0, cardCount: 3 });
await v4.put('flashcards', card('c1', { status: 'known' }));
await v4.put('flashcards', card('c2'));
await v4.put('flashcards', card('c3'));
await v4.put('testQuestions', {
  id: 'q1', deckId: 'd1', cardId: 'c2', stem: 'S?', correctAnswer: 'A', distractors: ['x', 'y', 'z'],
  explanation: 'e', sourceLabel: 'Page 1', cardHash: 'h', createdAt: 0,
  timesAsked: 0, lastAskedAt: null, timesCorrect: 0,
});
v4.close();

const db = await import('../src/db/db.ts');

const counts0 = await db.getStudyCounts([{ id: 'd1', cardCount: 3 }], NOW);
check('an upgraded deck opens with every card new', counts0.get('d1'), { due: 0, new: 3 });
check('an old "known" card is still new to the scheduler', (await db.getCardsForDeck('d1'))[0].srs, undefined);

// ---------------------------------------------------------------------------
console.log('\nGRADING');
// ---------------------------------------------------------------------------

const graded = await db.reviewCard('c1', 'good', NOW);
check('grading returns the stored card with a schedule', graded?.srs?.intervalDays, 1);
check('a graded card leaves the new count', (await db.getStudyCounts([{ id: 'd1', cardCount: 3 }], NOW)).get('d1'), { due: 0, new: 2 });
check(
  'it is due on the next day',
  (await db.getStudyCounts([{ id: 'd1', cardCount: 3 }], NOW + DAY)).get('d1'),
  { due: 1, new: 2 }
);

const early = await db.reviewCard('c1', 'good', NOW + 60_000);
check('a success before it is due changes nothing', early?.srs?.lastReviewedAt, NOW);

check('grading a deleted card returns undefined', await db.reviewCard('nope', 'good', NOW), undefined);

// ---------------------------------------------------------------------------
console.log('\nEDITING KEEPS THE SCHEDULE');
// ---------------------------------------------------------------------------

await db.updateCardContent('c1', { front: 'Edited?', back: 'Edited.' });
const [edited] = await db.getCardsForDeck('d1');
check('the new text is saved', [edited.front, edited.back], ['Edited?', 'Edited.']);
check('the schedule survives the edit', edited.srs?.intervalDays, 1);
await db.updateCardContent('gone', { front: 'x', back: 'y' });
check('editing a deleted card does not recreate it', (await db.getCardsForDeck('d1')).length, 3);

// ---------------------------------------------------------------------------
console.log('\nTEST ANSWERS');
// ---------------------------------------------------------------------------

await db.recordQuestionsAsked([{ questionId: 'q1', correct: false }], NOW);
const [q1] = await db.getQuestionsForDeck('d1');
check('a miss is counted on the question', [q1.timesAsked, q1.timesCorrect, q1.lastCorrect], [1, 0, false]);
const c2 = (await db.getCardsForDeck('d1')).find((c) => c.id === 'c2');
check('a miss makes the card due now', c2?.srs?.due, NOW);
check('... and marks it still learning', c2?.status, 'unknown');
check(
  'the missed card is counted as due',
  (await db.getStudyCounts([{ id: 'd1', cardCount: 3 }], NOW)).get('d1'),
  { due: 1, new: 1 }
);

await db.recordQuestionsAsked([{ questionId: 'q1', correct: true }], NOW + 1000);
const [q1b] = await db.getQuestionsForDeck('d1');
check('a later correct answer clears lastCorrect', q1b.lastCorrect, true);
const c2b = (await db.getCardsForDeck('d1')).find((c) => c.id === 'c2');
check('a correct answer leaves the card schedule alone', c2b?.srs?.lastReviewedAt, NOW);

await db.recordQuestionsAsked([{ questionId: 'missing', correct: false }], NOW);
check('an answer to a deleted question is skipped', (await db.getQuestionsForDeck('d1')).length, 1);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
