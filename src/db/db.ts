import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Deck, Flashcard, Folder, Infographic, TestQuestion } from '../types';
import { DuplicateFolderNameError, cleanFolderName, isDuplicateFolderName } from '../lib/deckFolders';
import { applyGrade, startOfNextDay, type Grade } from '../lib/scheduling';

interface FlashcardForgeDB extends DBSchema {
  decks: {
    key: string;
    value: Deck;
    indexes: { 'by-createdAt': number };
  };
  flashcards: {
    key: string;
    value: Flashcard;
    /**
     * `by-deck-due` holds only cards that have a schedule: IndexedDB leaves a
     * record out of an index when the key path is missing, and a new card has
     * no `srs`. That is what lets the library count due cards without reading
     * any card — and count new ones as cardCount minus the scheduled ones.
     */
    indexes: { 'by-deckId': string; 'by-deck-due': [string, number] };
  };
  testQuestions: {
    key: string;
    value: TestQuestion;
    indexes: { 'by-deckId': string; 'by-cardId': string };
  };
  /**
   * No index, and none on decks by folder: the library reads every deck anyway,
   * and an index on `folderId` would silently leave out the Unfiled decks,
   * whose key is absent.
   */
  folders: {
    key: string;
    value: Folder;
  };
  infographics: {
    key: string;
    value: Infographic;
    indexes: { 'by-deckId': string };
  };
}

const DB_NAME = 'flashcard-forge';
const DB_VERSION = 5;

let dbPromise: Promise<IDBPDatabase<FlashcardForgeDB>> | null = null;

/**
 * True once an upgrade has been refused by another tab still holding the old
 * database open. Read by the UI, because the alternative is a screen that waits
 * forever with nothing to explain itself.
 */
let upgradeBlocked = false;

/** Listeners waiting to hear that an upgrade is blocked. */
const upgradeBlockedListeners = new Set<() => void>();

/** True once an upgrade has been refused; read by the UI, set by blocked(). */
export function isUpgradeBlocked(): boolean {
  return upgradeBlocked;
}

/**
 * Calls `listener` when an upgrade turns out to be blocked, and returns an
 * unsubscribe function.
 *
 * A blocked open never settles — the promise neither resolves nor rejects while
 * another tab holds the old version — so nothing downstream can await its way to
 * finding out. This is the push half of that: the UI would otherwise have to
 * poll `isUpgradeBlocked` on a timer to notice.
 *
 * Fires immediately when it is already blocked, so a listener that subscribes
 * late does not miss the only notification it was ever going to get.
 */
export function onUpgradeBlocked(listener: () => void): () => void {
  if (upgradeBlocked) {
    listener();
    return () => {};
  }
  upgradeBlockedListeners.add(listener);
  return () => upgradeBlockedListeners.delete(listener);
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
       * app — so a first run falls through every block and gets every store.
       *
       * The version guards are load-bearing, not decoration: creating a store
       * that already exists throws ConstraintError, which on a version bump
       * would leave every existing user unable to open their decks at all.
       */
      upgrade(db, oldVersion, _newVersion, transaction) {
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

        // Additive only. Existing decks gain no field: an absent folderId is
        // what Unfiled means, so every deck from v2 arrives already filed.
        if (oldVersion < 3) {
          db.createObjectStore('folders', { keyPath: 'id' });
        }

        if (oldVersion < 4) {
          const infographicStore = db.createObjectStore('infographics', { keyPath: 'id' });
          infographicStore.createIndex('by-deckId', 'deckId');
        }

        // An index on an existing store, so it goes through the upgrade
        // transaction rather than db. IndexedDB fills it from the records
        // already there; cards without a schedule are simply not in it.
        if (oldVersion < 5) {
          transaction.objectStore('flashcards').createIndex('by-deck-due', ['deckId', 'srs.due']);
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
        for (const listener of upgradeBlockedListeners) listener();
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

/** Every deck, newest first — the order the library grid shows them in. */
export async function getAllDecks(): Promise<Deck[]> {
  const db = await getDB();
  const decks = await db.getAllFromIndex('decks', 'by-createdAt');
  return decks.reverse();
}

/** One deck by id, or undefined once it has been deleted. */
export async function getDeck(deckId: string): Promise<Deck | undefined> {
  const db = await getDB();
  return db.get('decks', deckId);
}

/**
 * A deck's cards in the order it was saved in.
 *
 * The index hands them back in primary-key order — by random UUID — so they
 * have to be put back in order here. `order` is the real answer: a save stamps
 * every card with one `Date.now()`, so sorting on `createdAt` sorts equal keys
 * and leaves the UUID order untouched, which is what read as a shuffle.
 *
 * Decks written before `order` existed have none, and there is nothing in those
 * records to recover a position from; they keep the old `createdAt` sort rather
 * than being migrated to an order that would be no more correct.
 */
export async function getCardsForDeck(deckId: string): Promise<Flashcard[]> {
  const db = await getDB();
  const cards = await db.getAllFromIndex('flashcards', 'by-deckId', deckId);
  const ordered = cards.every((card) => typeof card.order === 'number');
  if (ordered) return cards.sort((a, b) => a.order! - b.order!);
  return cards.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Writes new text onto a card, leaving everything else on the record alone.
 *
 * Read and write in one transaction, for the reason renameDeck gives. The deck
 * manager used to write back its whole in-memory card on every blur, which
 * would put back a schedule from whenever that screen loaded — undoing any
 * study done since in another tab. A card deleted meanwhile stays deleted.
 */
export async function updateCardContent(
  cardId: string,
  content: Pick<Flashcard, 'front' | 'back'>
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('flashcards', 'readwrite');
  const card = await tx.store.get(cardId);
  if (card) {
    card.front = content.front;
    card.back = content.back;
    await tx.store.put(card);
  }
  await tx.done;
}

/**
 * Grades one card and saves its new schedule, returning the card as stored.
 *
 * Read-modify-write on the stored record rather than on the caller's copy, so
 * a schedule is always computed from the latest one. Returns undefined when the
 * card has been deleted, and the unchanged card when the grade does not count
 * (see countsAsReview) — in which case nothing is written.
 */
export async function reviewCard(cardId: string, grade: Grade, now: number): Promise<Flashcard | undefined> {
  const db = await getDB();
  const tx = db.transaction('flashcards', 'readwrite');
  const card = await tx.store.get(cardId);
  if (!card) {
    await tx.done;
    return undefined;
  }
  const updated = applyGrade(card, grade, now);
  if (updated !== card) await tx.store.put(updated);
  await tx.done;
  return updated;
}

/**
 * Records that the model judged these cards to have nothing to apply, at
 * their current text, so the setup screen stops offering them for an
 * application question.
 *
 * Read-modify-write in one transaction, like updateCardContent: only the
 * marker changes, so a schedule written by a study session in another tab is
 * not put back. `cardHash` is the hash the verdict was reached on; if the card
 * has been edited since, the stored marker simply will not match its text, and
 * the card is offered again. A card deleted meanwhile stays deleted.
 */
export async function markApplicationSkipped(
  entries: { cardId: string; cardHash: string }[]
): Promise<void> {
  if (entries.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('flashcards', 'readwrite');
  const cards = await Promise.all(entries.map((entry) => tx.store.get(entry.cardId)));
  const writes: Promise<unknown>[] = [];
  cards.forEach((card, i) => {
    if (!card) return;
    card.applicationSkipHash = entries[i].cardHash;
    writes.push(tx.store.put(card));
  });
  await Promise.all([...writes, tx.done]);
}

/**
 * How many cards in each deck are due, and how many are new, without reading
 * a single card.
 *
 * Counts on the `by-deck-due` index: due is every scheduled card whose date
 * falls before the end of today, and new is the deck's cardCount less every
 * scheduled card. All counts are issued before any is awaited, in one
 * transaction, so a library of fifty decks is one round trip.
 */
export async function getStudyCounts(
  decks: Pick<Deck, 'id' | 'cardCount'>[],
  now: number
): Promise<Map<string, { due: number; new: number }>> {
  const db = await getDB();
  const index = db.transaction('flashcards').store.index('by-deck-due');
  const cutoff = startOfNextDay(now);

  const counts = await Promise.all(
    decks.map((deck) =>
      Promise.all([
        index.count(IDBKeyRange.bound([deck.id, -Infinity], [deck.id, cutoff], false, true)),
        index.count(IDBKeyRange.bound([deck.id, -Infinity], [deck.id, Infinity])),
      ])
    )
  );

  const result = new Map<string, { due: number; new: number }>();
  decks.forEach((deck, i) => {
    const [due, scheduled] = counts[i];
    result.set(deck.id, { due, new: Math.max(0, deck.cardCount - scheduled) });
  });
  return result;
}

/**
 * Adds one card and keeps its deck's running count in step.
 *
 * One transaction across both stores rather than three auto-commit ones. Split
 * apart, two cards added at once both read the same count and both write the
 * same increment, so the deck reports one fewer card than it holds.
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
 * All three in one transaction, so they cannot come apart: a card gone while
 * its deck still claims to hold it is untidy, but a question left behind is
 * worse — it goes on being asked about a card that no longer exists.
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

/**
 * Deletes a deck and everything written from it — its cards, their test
 * questions, and its infographics — as one transaction across all four stores.
 *
 * Cursors rather than a bulk delete, because IndexedDB has no "delete by index"
 * operation; the three child stores are swept by their by-deckId index. Nothing
 * here is recoverable, so the caller is expected to have confirmed first.
 */
export async function deleteDeck(deckId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['decks', 'flashcards', 'testQuestions', 'infographics'], 'readwrite');
  await tx.objectStore('decks').delete(deckId);

  for (const store of ['flashcards', 'testQuestions', 'infographics'] as const) {
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
 * Marks questions as asked, records whether they were answered correctly, and
 * sends the card behind every missed question back for review.
 *
 * Read-modify-write inside one transaction across both stores, so two answers
 * landing close together cannot overwrite each other's counts, and a miss can
 * never be counted on the question without reaching its card. A question or
 * card that has since been deleted is skipped rather than recreated — another
 * tab may have removed it while this test was running.
 *
 * A miss grades the card `again`, which makes it due now. A correct answer
 * leaves the card's schedule alone: picking the right option out of four is
 * recognition, weaker evidence than the recall a study session asks for, and
 * countsAsReview would ignore it on any card not yet due anyway.
 */
export async function recordQuestionsAsked(
  results: { questionId: string; correct: boolean }[],
  now: number = Date.now()
): Promise<void> {
  if (results.length === 0) return;
  const db = await getDB();
  const tx = db.transaction(['testQuestions', 'flashcards'], 'readwrite');
  const questionStore = tx.objectStore('testQuestions');
  const cardStore = tx.objectStore('flashcards');

  // Totalled per question first, so a question answered twice in one run is
  // still counted twice once the reads below are issued together. `last` is
  // the latest answer, which is the one lastCorrect should describe.
  const tally = new Map<string, { asked: number; correct: number; last: boolean }>();
  for (const { questionId, correct } of results) {
    const entry = tally.get(questionId) ?? { asked: 0, correct: 0, last: correct };
    entry.asked += 1;
    if (correct) entry.correct += 1;
    entry.last = correct;
    tally.set(questionId, entry);
  }

  // Every read is issued before any is awaited, then every write: a few round
  // trips rather than a few per question, with no gap for the transaction to
  // go inactive in.
  const ids = [...tally.keys()];
  const found = await Promise.all(ids.map((id) => questionStore.get(id)));

  const writes: Promise<unknown>[] = [];
  const missedCardIds = new Set<string>();
  found.forEach((question, i) => {
    if (!question) return;
    const entry = tally.get(ids[i])!;
    question.timesAsked += entry.asked;
    question.lastAskedAt = now;
    question.timesCorrect += entry.correct;
    question.lastCorrect = entry.last;
    if (entry.asked > entry.correct) missedCardIds.add(question.cardId);
    writes.push(questionStore.put(question));
  });

  const cardIds = [...missedCardIds];
  const cards = await Promise.all(cardIds.map((id) => cardStore.get(id)));
  for (const card of cards) {
    if (card) writes.push(cardStore.put(applyGrade(card, 'again', now)));
  }

  await Promise.all([...writes, tx.done]);
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

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

/** A cleaned folder name, or a thrown error when nothing is left after cleaning. */
function requireFolderName(name: string): string {
  const cleaned = cleanFolderName(name);
  if (!cleaned) throw new Error('A folder needs a name.');
  return cleaned;
}

/** Every folder, in no particular order. Screens sort them with sortFolders. */
export async function getAllFolders(): Promise<Folder[]> {
  const db = await getDB();
  return db.getAll('folders');
}

/**
 * Creates a folder, refusing a name another folder already has.
 *
 * The existing names are read inside the same readwrite transaction as the
 * write. Readwrite transactions on one store run one at a time, so two tabs
 * creating "Biology" at once cannot both pass the check.
 */
export async function createFolder(name: string): Promise<Folder> {
  const cleaned = requireFolderName(name);
  const db = await getDB();
  const tx = db.transaction('folders', 'readwrite');

  const existing = await tx.store.getAll();
  if (isDuplicateFolderName(cleaned, existing)) throw new DuplicateFolderNameError(cleaned);

  const folder: Folder = { id: crypto.randomUUID(), name: cleaned, createdAt: Date.now() };
  await Promise.all([tx.store.put(folder), tx.done]);
  return folder;
}

/**
 * Renames a folder, refusing a name a different folder already has.
 *
 * Re-casing a folder's own name is allowed. A folder deleted in the meantime
 * is left deleted rather than recreated.
 */
export async function renameFolder(folderId: string, name: string): Promise<void> {
  const cleaned = requireFolderName(name);
  const db = await getDB();
  const tx = db.transaction('folders', 'readwrite');

  const all = await tx.store.getAll();
  const folder = all.find((candidate) => candidate.id === folderId);
  if (folder) {
    if (isDuplicateFolderName(cleaned, all, folderId)) throw new DuplicateFolderNameError(cleaned);
    folder.name = cleaned;
    await tx.store.put(folder);
  }

  await tx.done;
}

/**
 * Deletes a folder and moves its decks to Unfiled. No deck is deleted.
 *
 * One transaction across both stores, so the folder cannot disappear while
 * decks written in this tab still point at it. The key is deleted rather than
 * set to undefined, so an unfiled deck looks exactly like one saved before
 * folders existed.
 */
export async function deleteFolder(folderId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['folders', 'decks'], 'readwrite');
  await tx.objectStore('folders').delete(folderId);

  let cursor = await tx.objectStore('decks').openCursor();
  while (cursor) {
    if (cursor.value.folderId === folderId) {
      const unfiled: Deck = { ...cursor.value };
      delete unfiled.folderId;
      await cursor.update(unfiled);
    }
    cursor = await cursor.continue();
  }

  await tx.done;
}

/**
 * Files a deck in a folder, or in no folder when `folderId` is null.
 *
 * Read and write in one transaction, for the reason renameDeck gives: apart, a
 * cardCount written by an addCard in the gap is silently reverted. The folder
 * is checked in the same transaction, so a deck is never pointed at a folder
 * another tab has just deleted.
 */
export async function moveDeckToFolder(deckId: string, folderId: string | null): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['decks', 'folders'], 'readwrite');

  if (folderId !== null && !(await tx.objectStore('folders').get(folderId))) {
    throw new Error('That folder no longer exists.');
  }

  const deckStore = tx.objectStore('decks');
  const deck = await deckStore.get(deckId);
  if (deck) {
    if (folderId === null) delete deck.folderId;
    else deck.folderId = folderId;
    await deckStore.put(deck);
  }

  await tx.done;
}

// ---------------------------------------------------------------------------
// Infographics
// ---------------------------------------------------------------------------

/**
 * Every infographic saved for a deck, newest first.
 *
 * Rows that don't match the current shape are deleted on read rather than
 * migrated. Two earlier shapes existed during this feature's development on
 * this branch (`sections`, then a `blocks` union); neither ever reached
 * `main`, so no released user has data here — but a developer who tried the
 * feature before the HTML rewrite will silently lose those rows the first
 * time this runs. That is the intended trade: an infographic is a
 * regenerable derivative of its deck, and the renderers for both old shapes
 * are gone.
 */
export async function getInfographicsForDeck(deckId: string): Promise<Infographic[]> {
  const db = await getDB();
  const infographics = await db.getAllFromIndex('infographics', 'by-deckId', deckId);
  const valid: Infographic[] = [];
  for (const infographic of infographics) {
    if (typeof (infographic as Infographic).html === 'string' && (infographic as Infographic).html.length > 0) {
      valid.push(infographic);
    } else {
      await db.delete('infographics', infographic.id).catch((err) => {
        console.error('[infographic] Could not clean up an invalid infographic row:', err);
      });
    }
  }
  return valid.sort((a, b) => b.createdAt - a.createdAt);
}

/** Stores one infographic. Always a new row — infographics are never overwritten by id. */
export async function saveInfographic(infographic: Infographic): Promise<void> {
  const db = await getDB();
  await db.put('infographics', infographic);
}

/** Removes one infographic. Does not touch the deck or any of its other infographics. */
export async function deleteInfographic(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('infographics', id);
}
