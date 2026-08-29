import type { Deck } from '../types';
import { deleteDeck } from '../db/db';

interface Props {
  decks: Deck[];
  loading: boolean;
  onNewDeck: () => void;
  onStudy: (deckId: string) => void;
  onManage: (deckId: string) => void;
  onDeckChange: () => void;
}

export default function DeckLibrary({ decks, loading, onNewDeck, onStudy, onManage, onDeckChange }: Props) {
  const handleDelete = async (e: React.MouseEvent, deckId: string, name: string) => {
    e.stopPropagation();
    if (!confirm(`Delete "${name}" and all its flashcards? This can't be undone.`)) return;
    await deleteDeck(deckId);
    onDeckChange();
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

      {!loading && decks.length === 0 && (
        <div className="empty-state">
          <div className="chalk-doodle" aria-hidden="true">
            ✎
          </div>
          <h2>The shelf is empty</h2>
          <p>Upload a PDF or PowerPoint and Flashcard Forge will draft a deck for you to review.</p>
          <button className="primary-btn" onClick={onNewDeck}>
            Upload your first document
          </button>
        </div>
      )}

      {!loading && decks.length > 0 && (
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
                  ✕
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
