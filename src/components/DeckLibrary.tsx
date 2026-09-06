import { useState } from 'react';
import type { Deck } from '../types';
import { confirmAndDeleteDeck } from '../lib/deckActions';
import ErrorNotice from './ui/ErrorNotice';

interface Props {
  /** Every saved deck, newest first. Loaded by the route, not by this screen. */
  decks: Deck[];
  loading: boolean;
  /** Why the deck list could not be read, if it could not be. */
  error?: string | null;
  onNewDeck: () => void;
  onStudy: (deckId: string) => void;
  onManage: (deckId: string) => void;
  /** Fired after a delete, so the route can re-read the list. */
  onDeckChange: () => void;
}

/**
 * The deck shelf: every saved deck, with an empty state for a first visit.
 *
 * Presentational apart from deleting — the list itself is loaded and owned by
 * LibraryRoute, so nothing else in the app has to remember to refresh it.
 */
export default function DeckLibrary({
  decks,
  loading,
  error,
  onNewDeck,
  onStudy,
  onManage,
  onDeckChange,
}: Props) {
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /**
   * Deletes a deck from its card's delete button.
   *
   * The click is stopped from propagating because the whole card is itself a
   * button that opens the deck — without it, deleting would also navigate.
   */
  const handleDelete = async (e: React.MouseEvent, deckId: string, name: string) => {
    e.stopPropagation();
    try {
      setDeleteError(null);
      if (await confirmAndDeleteDeck(deckId, name)) onDeckChange();
    } catch (err) {
      console.error('[library] Deleting the deck failed:', err);
      setDeleteError(`"${name}" could not be deleted.`);
    }
  };

  return (
    <div className="library">
      <div className="library-header">
        <div>
          <p className="eyebrow">Your card catalog</p>
          <h1>Decks on the shelf</h1>
        </div>
        <button className="primary-btn" onClick={onNewDeck}>
          + New deck from a file
        </button>
      </div>

      {loading && <p className="muted">Loading your decks…</p>}

      {error && <ErrorNotice title="Your decks could not be loaded" message={error} />}

      {deleteError && <ErrorNotice message={deleteError} />}

      {!loading && !error && decks.length === 0 && (
        <div className="empty-state">
          <div className="chalk-doodle" aria-hidden="true">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="7" width="14" height="10" rx="2" />
              <path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h9A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H17" />
            </svg>
          </div>
          <h2>The shelf is empty</h2>
          <p>Upload a PDF or PowerPoint and Flashcard Forge will draft a deck for you to review.</p>
          <button className="primary-btn" onClick={onNewDeck}>
            Upload your first document
          </button>
        </div>
      )}

      {!loading && !error && decks.length > 0 && (
        <div className="deck-grid">
          {decks.map((deck) => (
            <div key={deck.id} className="deck-card" onClick={() => onManage(deck.id)}>
              <div className="deck-card-top">
                <span className={`source-tag source-${deck.sourceType}`}>{deck.sourceType}</span>
                <button
                  className="icon-btn danger"
                  title="Delete deck"
                  onClick={(e) => handleDelete(e, deck.id, deck.name)}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <h3>{deck.name}</h3>
              <p className="deck-meta">
                {deck.cardCount} card{deck.cardCount === 1 ? '' : 's'} · from {deck.sourceFileName}
              </p>
              <div className="deck-card-actions">
                <button
                  className="secondary-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStudy(deck.id);
                  }}
                >
                  Study
                </button>
                <button
                  className="ghost-btn small"
                  onClick={(e) => {
                    e.stopPropagation();
                    onManage(deck.id);
                  }}
                >
                  Manage cards
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
