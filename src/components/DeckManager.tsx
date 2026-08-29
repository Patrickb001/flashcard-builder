import { useEffect, useState } from 'react';
import type { Deck, Flashcard } from '../types';
import { addCard, deleteCard, deleteDeck, getCardsForDeck, getDeck, renameDeck, updateCard } from '../db/db';

interface Props {
  deckId: string;
  onExit: () => void;
  onStudy: (deckId: string) => void;
  onDeckDeleted: () => void;
}

export default function DeckManager({ deckId, onExit, onStudy, onDeckDeleted }: Props) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [loading, setLoading] = useState(true);
  const [nameDraft, setNameDraft] = useState('');

  const load = async () => {
    const [d, c] = await Promise.all([getDeck(deckId), getCardsForDeck(deckId)]);
    setDeck(d ?? null);
    setCards(c);
    setNameDraft(d?.name ?? '');
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId]);

  const handleFieldChange = (id: string, field: 'front' | 'back', value: string) => {
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
  };

  const persistCard = async (card: Flashcard) => {
    await updateCard(card);
  };

  const handleAdd = async () => {
    if (!deck) return;
    const newCard: Flashcard = {
      id: crypto.randomUUID(),
      deckId,
      front: '',
      back: '',
      sourceLabel: 'Manual',
      status: 'new',
      createdAt: Date.now(),
    };
    await addCard(newCard);
    await load();
  };

  const handleDelete = async (cardId: string) => {
    await deleteCard(cardId, deckId);
    await load();
  };

  const handleDeleteDeck = async () => {
    if (!deck) return;
    if (!confirm(`Delete "${deck.name}" and all its flashcards? This can't be undone.`)) return;
    await deleteDeck(deckId);
    onDeckDeleted();
  };

  const commitName = async () => {
    if (!deck) return;
    const trimmed = nameDraft.trim() || 'Untitled deck';
    if (trimmed !== deck.name) {
      await renameDeck(deckId, trimmed);
      setDeck({ ...deck, name: trimmed });
    }
  };

  if (loading) return <p className="muted">Loading deck…</p>;
  if (!deck) return <p className="muted">This deck couldn't be found.</p>;

  return (
    <div className="manager">
      <div className="manager-header">
        <div>
          <p className="eyebrow">Manage cards</p>
          <input
            className="deck-title-input"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
          />
          <p className="muted small">
            {cards.length} card{cards.length === 1 ? '' : 's'} · from {deck.sourceFileName}
          </p>
        </div>
        <div className="manager-actions">
          <button className="primary-btn" onClick={() => onStudy(deckId)} disabled={cards.length === 0}>
            Study this deck
          </button>
          <button className="ghost-btn" onClick={onExit}>
            Back to library
          </button>
        </div>
      </div>

      <button className="secondary-btn" onClick={handleAdd}>
        + Add card
      </button>

      {cards.length === 0 ? (
        <p className="muted">No cards yet — add one above.</p>
      ) : (
        <ul className="candidate-list">
          {cards.map((card) => (
            <li key={card.id} className="candidate-row manager-row">
              <div className="candidate-fields">
                <textarea
                  className="candidate-front"
                  value={card.front}
                  rows={2}
                  onChange={(e) => handleFieldChange(card.id, 'front', e.target.value)}
                  onBlur={() => persistCard(cards.find((c) => c.id === card.id)!)}
                  placeholder="Front"
                />
                <textarea
                  className="candidate-back"
                  value={card.back}
                  rows={2}
                  onChange={(e) => handleFieldChange(card.id, 'back', e.target.value)}
                  onBlur={() => persistCard(cards.find((c) => c.id === card.id)!)}
                  placeholder="Back"
                />
                <span className="candidate-meta">
                  {card.context && <span className="topic-chip">{card.context}</span>}
                  <span className={`source-label status-${card.status}`}>
                    {card.sourceLabel} · {card.status}
                  </span>
                </span>
              </div>
              <button className="icon-btn danger" title="Delete card" onClick={() => handleDelete(card.id)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="danger-zone">
        <button className="ghost-btn danger-text" onClick={handleDeleteDeck}>
          Delete this deck
        </button>
      </div>
    </div>
  );
}
