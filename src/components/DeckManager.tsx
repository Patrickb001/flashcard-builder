import { useCallback, useEffect, useRef, useState } from "react";
import type { Deck, Flashcard } from "../types";
import {
  addCard,
  deleteCard,
  deleteDeck,
  getCardsForDeck,
  getDeck,
  renameDeck,
  updateCard,
} from "../db/db";
import {
  downloadTextFile,
  exportFileName,
  formatDeckForExport,
} from "../lib/deckExport";
import { Diagram, Snippet } from "./CardMedia";

interface Props {
  deckId: string;
  onExit: () => void;
  onStudy: (deckId: string) => void;
  onTest: (deckId: string) => void;
  onDeckDeleted: () => void;
}

export default function DeckManager({
  deckId,
  onExit,
  onStudy,
  onTest,
  onDeckDeleted,
}: Props) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [loading, setLoading] = useState(true);
  const [nameDraft, setNameDraft] = useState("");
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

  /**
   * Reads the deck and its cards into state.
   *
   * Fired from onClick handlers whose promises are dropped, so it reports its
   * own failures rather than surfacing them as unhandled rejections. `loading`
   * is cleared on both paths: clearing it only on success leaves the screen on
   * "Loading deck…" forever whenever IndexedDB is unavailable.
   */
  const load = useCallback(async () => {
    try {
      const [loadedDeck, loadedCards] = await Promise.all([
        getDeck(deckId),
        getCardsForDeck(deckId),
      ]);
      setDeck(loadedDeck ?? null);
      setCards(loadedCards);
      setNameDraft(loadedDeck?.name ?? "");
    } catch (err) {
      console.error("[manager] Could not read the deck:", err);
      setError("This deck could not be read from the browser database.");
    } finally {
      setLoading(false);
    }
  }, [deckId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleFieldChange = (
    id: string,
    field: "front" | "back",
    value: string,
  ) => {
    setCards((prev) =>
      prev.map((existing) => (existing.id === id ? { ...existing, [field]: value } : existing)),
    );
  };

  const persistCard = async (card: Flashcard) => {
    try {
      await updateCard(card);
    } catch (err) {
      console.error("[manager] Saving the card failed:", err);
      setError("That edit could not be saved.");
    }
  };

  const handleAdd = async () => {
    if (!deck) return;
    // Past the last card, so a hand-added one lands at the end of the deck
    // instead of wherever its UUID happened to fall.
    const lastOrder = cards.reduce(
      (max, c) => (typeof c.order === "number" && c.order > max ? c.order : max),
      -1,
    );
    const newCard: Flashcard = {
      id: crypto.randomUUID(),
      deckId,
      front: "",
      back: "",
      sourceLabel: "Manual",
      status: "new",
      createdAt: Date.now(),
      order: lastOrder + 1,
    };
    try {
      await addCard(newCard);
      await load();
    } catch (err) {
      console.error("[manager] Adding a card failed:", err);
      setError("The card could not be added.");
    }
  };

  const handleDelete = async (cardId: string) => {
    try {
      await deleteCard(cardId, deckId);
      await load();
    } catch (err) {
      console.error("[manager] Deleting the card failed:", err);
      setError("The card could not be deleted.");
    }
  };

  const handleDeleteDeck = async () => {
    if (!deck) return;
    if (
      !confirm(
        `Delete "${deck.name}" and all its flashcards? This can't be undone.`,
      )
    )
      return;
    try {
      await deleteDeck(deckId);
      onDeckDeleted();
    } catch (err) {
      console.error("[manager] Deleting the deck failed:", err);
      setError("The deck could not be deleted.");
    }
  };

  const handleExport = () => {
    if (!deck) return;
    try {
      downloadTextFile(exportFileName(deck.name), formatDeckForExport(cards));
    } catch (err) {
      console.error("[manager] Exporting the deck failed:", err);
      setError("The deck could not be exported.");
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
      console.error("[manager] Copying the deck failed:", err);
      setError("The deck could not be copied to the clipboard.");
    }
  };

  const commitName = async () => {
    if (!deck) return;
    const trimmed = nameDraft.trim() || "Untitled deck";
    if (trimmed !== deck.name) {
      try {
        await renameDeck(deckId, trimmed);
        setDeck({ ...deck, name: trimmed });
      } catch (err) {
        console.error("[manager] Renaming the deck failed:", err);
        setError("The deck could not be renamed.");
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
            {cards.length} card{cards.length === 1 ? "" : "s"} · from{" "}
            {deck.sourceFileName}
          </p>
        </div>
        <div className="manager-actions">
          <button
            className="primary-btn"
            onClick={() => onStudy(deckId)}
            disabled={cards.length === 0}
          >
            Study this deck
          </button>
          {/* One entry. The kind of test is chosen on the setup screen, which
              has to offer the picker anyway, and nothing is written until the
              button there is pressed — so there is nothing to decide this early. */}
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
            {copied ? "Copied ✓" : "Copy"}
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
                  onChange={(e) =>
                    handleFieldChange(card.id, "front", e.target.value)
                  }
                  onBlur={() =>
                    persistCard(card)
                  }
                  placeholder="Front"
                />
                <textarea
                  className="candidate-back"
                  value={card.back}
                  rows={2}
                  onChange={(e) =>
                    handleFieldChange(card.id, "back", e.target.value)
                  }
                  onBlur={() =>
                    persistCard(card)
                  }
                  placeholder="Back"
                />
                {/* Laid out as the review screen lays it out, so a card looks
                    the same before and after it is saved. Read-only here: the
                    text is editable, but a snippet is the source's own and
                    there is nothing on this screen to write one with. */}
                {(card.frontCode || card.backCode || card.image) && (
                  <div className="candidate-media">
                    {card.frontCode && (
                      <div className="candidate-attachment">
                        <span className="attachment-tag">
                          Shown with the question
                        </span>
                        <Snippet code={card.frontCode} />
                      </div>
                    )}
                    {card.backCode && (
                      <div className="candidate-attachment">
                        <span className="attachment-tag">
                          Shown with the answer
                        </span>
                        <Snippet code={card.backCode} />
                      </div>
                    )}
                    {card.image && (
                      <div className="candidate-attachment">
                        <span className="attachment-tag">
                          Shown with the answer
                        </span>
                        <Diagram image={card.image} />
                      </div>
                    )}
                  </div>
                )}
                <span className="candidate-meta">
                  {card.context && (
                    <span className="topic-chip">{card.context}</span>
                  )}
                  <span className={`source-label status-${card.status}`}>
                    {card.sourceLabel} · {card.status}
                  </span>
                </span>
              </div>
              <button
                className="icon-btn danger"
                title="Delete card"
                onClick={() => handleDelete(card.id)}
              >
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
