import { useCallback, useEffect, useState } from 'react';
import type { Deck } from './types';
import type { DocumentSection } from './lib/documentModel';
import type { AiSettings } from './lib/aiGenerator';
import { getAllDecks, isUpgradeBlocked } from './db/db';
import Uploader from './components/Uploader';
import type { SourceType } from './components/Uploader';
import CandidateReview from './components/CandidateReview';
import StudyMode from './components/StudyMode';
import TestMode from './components/TestMode';
import DeckManager from './components/DeckManager';
import DeckLibrary from './components/DeckLibrary';

type View =
  | { name: 'library' }
  | { name: 'upload' }
  | {
      name: 'review';
      sections: DocumentSection[];
      fileName: string;
      sourceType: SourceType;
      ai: AiSettings;
      notice?: string;
    }
  | { name: 'study'; deckId: string }
  | { name: 'test'; deckId: string }
  | { name: 'manage'; deckId: string };

export default function App() {
  const [view, setView] = useState<View>({ name: 'library' });
  const [decks, setDecks] = useState<Deck[]>([]);
  const [loadingDecks, setLoadingDecks] = useState(true);
  const [decksError, setDecksError] = useState<string | null>(null);

  // loading is cleared on both paths. Clearing it only on success is what
  // left this screen spinning forever whenever IndexedDB was unavailable -
  // a private window, a full disk, storage switched off.
  const refreshDecks = useCallback(async () => {
    setLoadingDecks(true);
    setDecksError(null);
    try {
      const all = await getAllDecks();
      setDecks(all);
    } catch (err) {
      console.error('[app] Could not read the deck list:', err);
      setDecksError(
        'Your decks could not be read from this browser. They are stored locally, so a private window or blocked site data will do this.'
      );
    } finally {
      setLoadingDecks(false);
    }
  }, []);

  useEffect(() => {
    refreshDecks();
  }, [refreshDecks]);

  /**
   * Reports an upgrade another tab is holding open.
   *
   * That case never rejects and never resolves - idb's open promise simply
   * never settles - so the catch above cannot see it. Polling the flag is what
   * turns a permanent spinner into a sentence telling you to close the tab.
   */
  useEffect(() => {
    if (!loadingDecks) return;
    const timer = setInterval(() => {
      if (!isUpgradeBlocked()) return;
      setDecksError(
        'Another tab has an older version of this app open, which is blocking an upgrade. Close the other tabs and reload.'
      );
      setLoadingDecks(false);
    }, 400);
    return () => clearInterval(timer);
  }, [loadingDecks]);

  return (
    <div className="app-shell">
      <header className="top-bar">
        <button className="brand" onClick={() => setView({ name: 'library' })}>
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 40 40" width="28" height="28">
              <line x1="10" y1="8" x2="10" y2="32" />
              <line x1="16" y1="8" x2="16" y2="32" />
              <line x1="22" y1="8" x2="22" y2="32" />
              <line x1="28" y1="8" x2="28" y2="32" />
              <line x1="7" y1="28" x2="31" y2="10" />
            </svg>
          </span>
          <span className="brand-text">
            Flashcard <em>Forge</em>
          </span>
        </button>
        {view.name !== 'library' && (
          <button className="ghost-btn" onClick={() => setView({ name: 'library' })}>
            ← Back to library
          </button>
        )}
      </header>

      <main className="stage">
        {view.name === 'library' && (
          <DeckLibrary
            decks={decks}
            loading={loadingDecks}
            error={decksError}
            onNewDeck={() => setView({ name: 'upload' })}
            onStudy={(deckId) => setView({ name: 'study', deckId })}
            onManage={(deckId) => setView({ name: 'manage', deckId })}
            onDeckChange={refreshDecks}
          />
        )}

        {view.name === 'upload' && (
          <Uploader
            onParsed={(sections, fileName, sourceType, ai, notice) =>
              setView({ name: 'review', sections, fileName, sourceType, ai, notice })
            }
            onCancel={() => setView({ name: 'library' })}
          />
        )}

        {view.name === 'review' && (
          <CandidateReview
            sections={view.sections}
            fileName={view.fileName}
            sourceType={view.sourceType}
            ai={view.ai}
            notice={view.notice}
            onSaved={async (deckId) => {
              await refreshDecks();
              setView({ name: 'manage', deckId });
            }}
            onCancel={() => setView({ name: 'library' })}
          />
        )}

        {view.name === 'study' && (
          <StudyMode deckId={view.deckId} onExit={() => setView({ name: 'library' })} />
        )}

        {view.name === 'test' && (
          <TestMode deckId={view.deckId} onExit={() => setView({ name: 'library' })} />
        )}

        {view.name === 'manage' && (
          <DeckManager
            deckId={view.deckId}
            onExit={() => setView({ name: 'library' })}
            onStudy={(deckId) => setView({ name: 'study', deckId })}
            onTest={(deckId) => setView({ name: 'test', deckId })}
            onDeckDeleted={async () => {
              await refreshDecks();
              setView({ name: 'library' });
            }}
          />
        )}
      </main>
    </div>
  );
}
