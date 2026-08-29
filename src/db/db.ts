import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Deck, Flashcard } from '../types';

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
}

const DB_NAME = 'flashcard-forge';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<FlashcardForgeDB>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<FlashcardForgeDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const deckStore = db.createObjectStore('decks', { keyPath: 'id' });
        deckStore.createIndex('by-createdAt', 'createdAt');

        const cardStore = db.createObjectStore('flashcards', { keyPath: 'id' });
        cardStore.createIndex('by-deckId', 'deckId');
      },
    });
  }
  return dbPromise;
}

export async function saveDeckWithCards(deck: Deck, cards: Flashcard[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['decks', 'flashcards'], 'readwrite');
  await tx.objectStore('decks').put(deck);
  const cardStore = tx.objectStore('flashcards');
  for (const card of cards) {
    await cardStore.put(card);
  }
  await tx.done;
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

export async function addCard(card: Flashcard): Promise<void> {
  const db = await getDB();
  await db.put('flashcards', card);
  const deck = await db.get('decks', card.deckId);
  if (deck) {
    deck.cardCount += 1;
    await db.put('decks', deck);
  }
}

export async function deleteCard(cardId: string, deckId: string): Promise<void> {
  const db = await getDB();
  await db.delete('flashcards', cardId);
  const deck = await db.get('decks', deckId);
  if (deck) {
    deck.cardCount = Math.max(0, deck.cardCount - 1);
    await db.put('decks', deck);
  }
}

export async function deleteDeck(deckId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['decks', 'flashcards'], 'readwrite');
  await tx.objectStore('decks').delete(deckId);
  const cardStore = tx.objectStore('flashcards');
  const index = cardStore.index('by-deckId');
  let cursor = await index.openCursor(IDBKeyRange.only(deckId));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function renameDeck(deckId: string, name: string): Promise<void> {
  const db = await getDB();
  const deck = await db.get('decks', deckId);
  if (deck) {
    deck.name = name;
    await db.put('decks', deck);
  }
}
