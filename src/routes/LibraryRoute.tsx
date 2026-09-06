import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Deck } from '../types';
import { getAllDecks, onUpgradeBlocked } from '../db/db';
import DeckLibrary from '../components/DeckLibrary';

/**
 * The deck list, and the state behind it.
 *
 * The list belongs to this route rather than to App, so arriving here mounts it
 * and loading is simply what mounting does. No other screen has to remember to
 * refresh the library after saving or deleting a deck.
 */
export default function LibraryRoute() {
  const navigate = useNavigate();
  const [decks, setDecks] = useState<Deck[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // loading is cleared on both paths. Clearing it only on success is what
  // left this screen spinning forever whenever IndexedDB was unavailable -
  // a private window, a full disk, storage switched off.
  const refreshDecks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const all = await getAllDecks();
      setDecks(all);
    } catch (err) {
      console.error('[app] Could not read the deck list:', err);
      setError(
        'Your decks could not be read from this browser. They are stored locally, so a private window or blocked site data will do this.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshDecks();
  }, [refreshDecks]);

  /**
   * Reports an upgrade another tab is holding open.
   *
   * That case never rejects and never resolves — idb's open promise simply
   * never settles — so the catch above cannot see it, and without this the
   * screen would spin forever with nothing to explain why.
   */
  useEffect(() => {
    return onUpgradeBlocked(() => {
      setError(
        'Another tab has an older version of this app open, which is blocking an upgrade. Close the other tabs and reload.'
      );
      setLoading(false);
    });
  }, []);

  return (
    <DeckLibrary
      decks={decks}
      loading={loading}
      error={error}
      onNewDeck={() => navigate('/upload')}
      onStudy={(deckId) => navigate(`/deck/${deckId}/study`)}
      onManage={(deckId) => navigate(`/deck/${deckId}`)}
      onDeckChange={refreshDecks}
    />
  );
}
