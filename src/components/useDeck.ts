import { useCallback, useEffect, useState } from 'react';
import type { Deck, Flashcard } from '../types';
import { getCardsForDeck, getDeck } from '../db/db';

/**
 * Reads one deck and its cards, with the loading and failure states every deck
 * screen needs.
 *
 * The manage, study and test screens each did this themselves, which meant three
 * copies of the same read, the same two state flags and the same three guard
 * messages. Render the guards with <DeckGate>, which takes what this returns.
 *
 * A read that is still in flight when the deck id changes is discarded rather
 * than applied: navigating quickly from one deck to another otherwise lands the
 * first deck's cards in the second deck's screen.
 */
export function useDeck(deckId: string) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Re-reads the deck. Exposed so a screen that has just written can refresh.
   *
   * Returns nothing and throws nothing: failures are reported through `error`,
   * because every caller fires this from an event handler and drops the promise.
   */
  const reload = useCallback(async () => {
    try {
      const [loadedDeck, loadedCards] = await Promise.all([
        getDeck(deckId),
        getCardsForDeck(deckId),
      ]);
      setDeck(loadedDeck ?? null);
      setCards(loadedCards);
    } catch (err) {
      console.error('[deck] Could not read the deck:', err);
      setError('This deck could not be read from the browser database.');
    } finally {
      // Cleared on both paths. Clearing it only on success leaves the screen on
      // "Loading deck…" forever whenever IndexedDB is unavailable — a private
      // window, a full disk, site data switched off.
      setLoading(false);
    }
  }, [deckId]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const [loadedDeck, loadedCards] = await Promise.all([
          getDeck(deckId),
          getCardsForDeck(deckId),
        ]);
        if (cancelled) return;
        setDeck(loadedDeck ?? null);
        setCards(loadedCards);
      } catch (err) {
        if (cancelled) return;
        console.error('[deck] Could not read the deck:', err);
        setError('This deck could not be read from the browser database.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [deckId]);

  return { deck, setDeck, cards, setCards, loading, error, setError, reload };
}
