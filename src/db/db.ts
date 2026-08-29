import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Deck, Flashcard, TestQuestion } from '../types';

interface FlashcardForgeDB extends DBSchema {
  decks: {
    key: string;
    value: Deck;
    indexes: { 'by-createdAt': number };
  };
  flashcards: {
    key: string;
    value: Flashcard;
    indexes: { 'by-deckId': string };
  };
  testQuestions: {
    key: string;
    value: TestQuestion;
    indexes: { 'by-deckId': string; 'by-cardId': string };
  };
}

const DB_NAME = 'flashcard-forge';
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase<FlashcardForgeDB>> | null = null;

/**
 * True once an upgrade has been refused by another tab still holding the old
 * database open. Read by the UI, because the alternative is a screen that waits
 * forever with nothing to explain itself.
 */
let upgradeBlocked = false;

export function isUpgradeBlocked(): boolean {
  return upgradeBlocked;
}

/**
 * The open database, opened once and shared.
 *
 * The memoised promise is cleared again if the open fails. Without that, a
 * single transient error - storage pressure, a private window refusing
 * persistence - is cached as a rejection and every one of the exports below
 * keeps rethrowing it for the rest of the session, with no way back short of
 * a reload.
 */
function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<FlashcardForgeDB>(DB_NAME, DB_VERSION, {
      /**
       * Each block runs only for a database old enough to be missing that
       * store, and `oldVersion` is 0 for a browser that has never opened this
       * app — so a first run falls through every block and gets all three.
       *
       * The version check is not decoration. This callback used to create both
       * stores unconditionally, which is harmless while the version never
       * moves and throws `ConstraintError` on the first bump, leaving every
       * existing user unable to open their decks at all.
       */
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const deckStore = db.createObjectStore('decks', { keyPath: 'id' });
          deckStore.createIndex('by-createdAt', 'createdAt');

          const cardStore = db.createObjectStore('flashcards', { keyPath: 'id' });
          cardStore.createIndex('by-deckId', 'deckId');
        }

        if (oldVersion < 2) {
          const questionStore = db.createObjectStore('testQuestions', { keyPath: 'id' });
          questionStore.createIndex('by-deckId', 'deckId');
          questionStore.createIndex('by-cardId', 'cardId');
        }
      },

      /**
       * Another tab is still holding the previous version open, so the upgrade
       * cannot proceed. This promise never settles while that is true, and it
       * is memoised, so every caller in the app waits on it indefinitely. The
       * flag is what lets the UI say so instead of showing a spinner forever.
       */
      blocked() {
        upgradeBlocked = true;
        console.error(
          '[db] Database upgrade is blocked by another tab with this app open. Close the other tabs and reload.'
        );
      },

      /** The browser dropped the connection; let the next call reopen it. */
      terminated() {
        dbPromise = null;
      },
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

/**
 * Writes a deck and its cards as one unit.
 *
 * Every put is issued before any is awaited. Awaiting each in turn hands
 * control back to the event loop between writes, which is the documented way
 * to find a transaction has gone inactive underneath you, and it costs one
 * round trip per card rather than one for the batch.
 */
export async function saveDeckWithCards(deck: Deck, cards: Flashcard[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['decks', 'flashcards'], 'readwrite');
  const cardStore = tx.objectStore('flashcards');

  const writes: Promise<unknown>[] = [tx.objectStore('decks').put(deck)];
  for (const card of cards) writes.push(cardStore.put(card));

  await Promise.all([...writes, tx.done]);
}

export async function getAllDecks(): Promise<Deck[]> {
  const db = await getDB();
  const decks = await db.getAllFromIndex('decks', 'by-createdAt');
  return decks.reverse();
}

export async function getDeck(deckId: string): Promise<Deck | undefined> {
  const db = await getDB();
  return db.get('decks', deckId);
}

export async function getCardsForDeck(deckId: string): Promise<Flashcard[]> {
  const db = await getDB();
  const cards = await db.getAllFromIndex('flashcards', 'by-deckId', deckId);
  return cards.sort((a, b) => a.createdAt - b.createdAt);
}

export async function updateCard(card: Flashcard): Promise<void> {
  const db = await getDB();
  await db.put('flashcards', card);
}

/**
 * Adds one card and keeps its deck's running count in step.
 *
 * One transaction across both stores, where this was three separate
 * auto-commit transactions: put the card, read the deck, write the count.
 * Two cards added at once would both read the same count and both write the
 * same increment, so the deck would report one fewer card than it holds.
 * deleteCard already had this shape - see the comment there.
 */
export async function addCard(card: Flashcard): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['flashcards', 'decks'], 'readwrite');

  const cardWrite = tx.objectStore('flashcards').put(card);
  const deckStore = tx.objectStore('decks');
  const deck = await deckStore.get(card.deckId);
  if (deck) {
    deck.cardCount += 1;
    await deckStore.put(deck);
  }

  await Promise.all([cardWrite, tx.done]);
}

/**
 * Deletes a card, its deck's running count, and any test question written from
 * it.
 *
 * One transaction across all three, where this used to be three separate
 * awaits: apart, a card could be gone while the deck still claimed to hold it.
 * A question left behind would be worse than untidy — it would go on being
 * asked about a card that no longer exists.
 */
export async function deleteCard(cardId: string, deckId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['flashcards', 'decks', 'testQuestions'], 'readwrite');

  await tx.objectStore('flashcards').delete(cardId);

  const deckStore = tx.objectStore('decks');
  const deck = await deckStore.get(deckId);
  if (deck) {
    deck.cardCount = Math.max(0, deck.cardCount - 1);
    await deckStore.put(deck);
  }

  const byCard = tx.objectStore('testQuestions').index('by-cardId');
  let cursor = await byCard.openCursor(IDBKeyRange.only(cardId));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }

  await tx.done;
}

export async function deleteDeck(deckId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['decks', 'flashcards', 'testQuestions'], 'readwrite');
  await tx.objectStore('decks').delete(deckId);

  for (const store of ['flashcards', 'testQuestions'] as const) {
    const index = tx.objectStore(store).index('by-deckId');
    let cursor = await index.openCursor(IDBKeyRange.only(deckId));
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
  }

  await tx.done;
}

// ---------------------------------------------------------------------------
// Test questions
// ---------------------------------------------------------------------------

/** Every question written for a deck, oldest first, matching getCardsForDeck. */
export async function getQuestionsForDeck(deckId: string): Promise<TestQuestion[]> {
  const db = await getDB();
  const questions = await db.getAllFromIndex('testQuestions', 'by-deckId', deckId);
  return questions.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Stores a batch of questions.
 *
 * Called once per generated batch rather than once at the end, so a run that
 * fails halfway keeps everything it earned up to that point. The cards it never
 * reached are picked up by the same "some cards have no question" prompt that
 * handles cards added later, so there is no separate retry to build.
 */
export async function saveQuestions(questions: TestQuestion[]): Promise<void> {
  if (questions.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('testQuestions', 'readwrite');
  const writes = questions.map((question) => tx.store.put(question));
  await Promise.all([...writes, tx.done]);
}

/**
 * Marks questions as asked, and records whether they were answered correctly.
 *
 * Read-modify-write inside one transaction so two answers landing close
 * together cannot overwrite each other's counts. A question that has since been
 * deleted is skipped rather than recreated — another tab may have removed its
 * card while this test was running.
 */
export async function recordQuestionsAsked(
  results: { questionId: string; correct: boolean }[]
): Promise<void> {
  if (results.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('testQuestions', 'readwrite');
  const now = Date.now();

  // Totalled per question first, so a question answered twice in one run is
  // still counted twice once the reads below are issued together.
  const tally = new Map<string, { asked: number; correct: number }>();
  for (const { questionId, correct } of results) {
    const entry = tally.get(questionId) ?? { asked: 0, correct: 0 };
    entry.asked += 1;
    if (correct) entry.correct += 1;
    tally.set(questionId, entry);
  }

  // Every read is issued before any is awaited, then every write: two round
  // trips rather than two per question, with no gap for the transaction to
  // go inactive in.
  const ids = [...tally.keys()];
  const found = await Promise.all(ids.map((id) => tx.store.get(id)));

  const writes: Promise<unknown>[] = [];
  found.forEach((question, i) => {
    // Skipped rather than recreated: another tab may have deleted the card
    // this question came from while the test was running.
    if (!question) return;
    const entry = tally.get(ids[i])!;
    question.timesAsked += entry.asked;
    question.lastAskedAt = now;
    question.timesCorrect += entry.correct;
    writes.push(tx.store.put(question));
  });

  await Promise.all([...writes, tx.done]);
}

/** Removes one question, for a question the user reports as wrong. */
export async function deleteQuestion(questionId: string): Promise<void> {
  const db = await getDB();
  await db.delete('testQuestions', questionId);
}

/**
 * Drops questions whose source card is gone, and reports how many.
 *
 * The delete cascade already handles this, so in normal use it finds nothing.
 * It runs at test launch as a backstop: it is one index scan, and it repairs
 * any deck left inconsistent by an earlier build or a half-finished delete.
 */
export async function pruneOrphanQuestions(
  deckId: string,
  liveCardIds: Set<string>
): Promise<number> {
  const db = await getDB();
  const tx = db.transaction('testQuestions', 'readwrite');
  const index = tx.store.index('by-deckId');
  let cursor = await index.openCursor(IDBKeyRange.only(deckId));
  let removed = 0;

  while (cursor) {
    if (!liveCardIds.has(cursor.value.cardId)) {
      await cursor.delete();
      removed += 1;
    }
    cursor = await cursor.continue();
  }

  await tx.done;
  return removed;
}

/**
 * Renames a deck.
 *
 * Read and write in one transaction. Apart, this read a whole deck object,
 * held it across a gap, and wrote all of it back - so a cardCount written by
 * an addCard in that gap was silently reverted to the value this read saw.
 */
export async function renameDeck(deckId: string, name: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('decks', 'readwrite');

  const deck = await tx.store.get(deckId);
  if (deck) {
    deck.name = name;
    await tx.store.put(deck);
  }

  await tx.done;
}
