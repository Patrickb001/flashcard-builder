import { useEffect, useRef, useState } from 'react';
import type { Deck, Flashcard } from '../types';
import { addCard, deleteCard, deleteDeck, getCardsForDeck, getDeck, renameDeck, updateCard } from '../db/db';
import { downloadTextFile, exportFileName, formatDeckForExport } from '../lib/deckExport';

interface Props {
  deckId: string;
  onExit: () => void;
  onStudy: (deckId: string) => void;
  onTest: (deckId: string) => void;
  onDeckDeleted: () => void;
}

export default function DeckManager({ deckId, onExit, onStudy, onTest, onDeckDeleted }: Props) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [loading, setLoading] = useState(true);
  const [nameDraft, setNameDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);

  // The copy confirmation outlives its click by two seconds, so a navigation in
  // between would leave the timer setting state on a component that is gone.
  useEffect(() => {
    return () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    };
  }, []);

  // Every one of these handlers is fired from an onClick and its promise is
  // dropped, so anything that throws inside would otherwise surface only as an
  // unhandled rejection in the console. Each one reports instead.
  const load = async () => {
    try {
      const [d, c] = await Promise.all([getDeck(deckId), getCardsForDeck(deckId)]);
      setDeck(d ?? null);
      setCards(c);
      setNameDraft(d?.name ?? '');
    } catch (err) {
      console.error('[manager] Could not read the deck:', err);
      setError('This deck could not be read from the browser database.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId]);

  const handleFieldChange = (id: string, field: 'front' | 'back', value: string) => {
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
  };

  const persistCard = async (card: Flashcard) => {
    try {
      await updateCard(card);
    } catch (err) {
      console.error('[manager] Saving the card failed:', err);
      setError('That edit could not be saved.');
    }
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
    try {
      await addCard(newCard);
      await load();
    } catch (err) {
      console.error('[manager] Adding a card failed:', err);
      setError('The card could not be added.');
    }
  };

  const handleDelete = async (cardId: string) => {
    try {
      await deleteCard(cardId, deckId);
      await load();
    } catch (err) {
      console.error('[manager] Deleting the card failed:', err);
      setError('The card could not be deleted.');
    }
  };

  const handleDeleteDeck = async () => {
    if (!deck) return;
    if (!confirm(`Delete "${deck.name}" and all its flashcards? This can't be undone.`)) return;
    try {
      await deleteDeck(deckId);
      onDeckDeleted();
    } catch (err) {
      console.error('[manager] Deleting the deck failed:', err);
      setError('The deck could not be deleted.');
    }
  };

  const handleExport = () => {
    if (!deck) return;
    try {
      downloadTextFile(exportFileName(deck.name), formatDeckForExport(cards));
    } catch (err) {
      console.error('[manager] Exporting the deck failed:', err);
      setError('The deck could not be exported.');
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formatDeckForExport(cards));
      setCopied(true);
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      // Clipboard writes are refused outside a secure context or without permission.
      console.error('[manager] Copying the deck failed:', err);
      setError('The deck could not be copied to the clipboard.');
    }
  };

  const commitName = async () => {
    if (!deck) return;
    const trimmed = nameDraft.trim() || 'Untitled deck';
    if (trimmed !== deck.name) {
      try {
        await renameDeck(deckId, trimmed);
        setDeck({ ...deck, name: trimmed });
      } catch (err) {
        console.error('[manager] Renaming the deck failed:', err);
        setError('The deck could not be renamed.');
        setNameDraft(deck.name);
      }
    }
  };

  if (loading) return <p className="muted">Loading deck…</p>;
  if (error && !deck)
    return (
      <div className="ai-notice failed">
        <strong>This deck could not be opened</strong>
        <p>{error}</p>
      </div>
    );
  if (!deck) return <p className="muted">This deck couldn't be found.</p>;

  return (
    <div className="manager">
      {error && (
        <div className="ai-notice failed">
          <p>{error}</p>
        </div>
      )}
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
          <button
            className="secondary-btn"
            onClick={() => onTest(deckId)}
            disabled={cards.length === 0}
          >
            Test this deck
          </button>
          <button className="ghost-btn" onClick={onExit}>
            Back to library
          </button>
        </div>
      </div>

      <div className="manager-toolbar">
        <button className="secondary-btn" onClick={handleAdd}>
          + Add card
        </button>
        <div className="manager-export">
          <button
            className="ghost-btn small"
            onClick={handleExport}
            disabled={cards.length === 0}
            title="Save the deck as a text file"
          >
            Download .txt
          </button>
          <button
            className="ghost-btn small"
            onClick={handleCopy}
            disabled={cards.length === 0}
            title="Copy the deck as delimited text"
          >
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
      </div>

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
