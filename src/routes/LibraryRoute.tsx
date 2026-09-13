import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Deck, Folder } from '../types';
import { getAllDecks, getAllFolders, onUpgradeBlocked } from '../db/db';
import { parseFolderFilter } from '../lib/deckFolders';
import DeckLibrary from '../components/DeckLibrary';

/**
 * The deck shelf, its folders, and the state behind them.
 *
 * The lists belong to this route rather than to App, so arriving here mounts it
 * and loading is simply what mounting does. No other screen has to remember to
 * refresh the library after saving or deleting a deck.
 *
 * Which folder is open lives in the URL (`?folder=`), so Back, reload and a
 * copied link all return to the same view.
 */
export default function LibraryRoute() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [decks, setDecks] = useState<Deck[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // loading is cleared on both paths. Clearing it only on success is what
  // left this screen spinning forever whenever IndexedDB was unavailable -
  // a private window, a full disk, storage switched off.
  const refreshLibrary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Read together, so the folder bar's counts and the grid always describe
      // the same moment.
      const [allDecks, allFolders] = await Promise.all([getAllDecks(), getAllFolders()]);
      setDecks(allDecks);
      setFolders(allFolders);
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
    refreshLibrary();
  }, [refreshLibrary]);

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

  const filter = parseFolderFilter(searchParams.get('folder'), folders);

  return (
    <DeckLibrary
      decks={decks}
      folders={folders}
      filter={filter}
      loading={loading}
      error={error}
      onNewDeck={(folderId) =>
        navigate(folderId ? `/upload?folder=${encodeURIComponent(folderId)}` : '/upload')
      }
      onSelectFolder={(next) => setSearchParams(next === 'all' ? {} : { folder: next })}
      onStudy={(deckId) => navigate(`/deck/${deckId}/study`)}
      onManage={(deckId) => navigate(`/deck/${deckId}`)}
      onLibraryChange={refreshLibrary}
    />
  );
}
