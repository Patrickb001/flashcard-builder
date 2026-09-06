import { useEffect, useRef, useState } from "react";
import type { Flashcard } from "../types";
import { addCard, deleteCard, renameDeck, updateCard } from "../db/db";
import { confirmAndDeleteDeck } from "../lib/deckActions";
import {
  downloadTextFile,
  exportFileName,
  formatDeckForExport,
} from "../lib/deckExport";
import { useDeck } from "./useDeck";
import CardAttachments from "./ui/CardAttachments";
import DeckGate from "./ui/DeckGate";
import ErrorNotice from "./ui/ErrorNotice";

interface Props {
  /** The deck to manage. Everything on screen is read from it on mount. */
  deckId: string;
  onExit: () => void;
  onStudy: (deckId: string) => void;
  onTest: (deckId: string) => void;
  /**
   * Fired after the deck is deleted, so the caller can navigate away. This
   * screen cannot show a deck that no longer exists, so it does not try.
   */
  onDeckDeleted: () => void;
}

/**
 * The deck detail screen: rename the deck, edit its cards, export it, delete it.
 *
 * Card edits are held in local state and written on blur rather than on every
 * keystroke, so typing does not queue an IndexedDB write per character. A failed
 * write leaves the edit on screen and says so, because losing what someone just
 * typed is worse than a stale row in the database.
 */
export default function DeckManager({
  deckId,
  onExit,
  onStudy,
  onTest,
  onDeckDeleted,
}: Props) {
  const { deck, setDeck, cards, setCards, loading, error, setError, reload } =
    useDeck(deckId);
  const [nameDraft, setNameDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);

  // The name is a draft the user edits, so it is seeded from the deck once it
  // arrives rather than being read straight from it on every render.
  useEffect(() => {
    setNameDraft(deck?.name ?? "");
  }, [deck?.name]);

  // The copy confirmation outlives its click by two seconds, so a navigation in
  // between would leave the timer setting state on a component that is gone.
  useEffect(() => {
    return () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    };
  }, []);

  /** Updates a card in local state only; persistCard writes it on blur. */
  const handleFieldChange = (
    id: string,
    field: "front" | "back",
    value: string,
  ) => {
    setCards((prev) =>
      prev.map((existing) => (existing.id === id ? { ...existing, [field]: value } : existing)),
    );
  };

  /** Writes one edited card. A failed write leaves the edit on screen. */
  const persistCard = async (card: Flashcard) => {
    try {
      await updateCard(card);
    } catch (err) {
      console.error("[manager] Saving the card failed:", err);
      setError("That edit could not be saved.");
    }
  };

  /** Appends a blank card to the end of the deck, then reloads. */
  const handleAdd = async () => {
    if (!deck) return;
    // Past the last card, so a hand-added one lands at the end of the deck
    // instead of wherever its UUID happened to fall.
    const lastOrder = cards.reduce(
      (max, existing) =>
        typeof existing.order === "number" && existing.order > max ? existing.order : max,
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
      await reload();
    } catch (err) {
      console.error("[manager] Adding a card failed:", err);
      setError("The card could not be added.");
    }
  };

  /** Removes one card, along with any test question written from it. */
  const handleDelete = async (cardId: string) => {
    try {
      await deleteCard(cardId, deckId);
      await reload();
    } catch (err) {
      console.error("[manager] Deleting the card failed:", err);
      setError("The card could not be deleted.");
    }
  };

  /**
   * Deletes the deck and everything in it, after confirming.
   *
   * Irreversible — nothing is kept elsewhere and there is no undo — so the
   * confirmation names the deck rather than asking a generic "are you sure".
   */
  const handleDeleteDeck = async () => {
    if (!deck) return;
    try {
      if (await confirmAndDeleteDeck(deckId, deck.name)) onDeckDeleted();
    } catch (err) {
      console.error("[manager] Deleting the deck failed:", err);
      setError("The deck could not be deleted.");
    }
  };

  /** Saves the deck as a delimited .txt file, for importing elsewhere. */
  const handleExport = () => {
    if (!deck) return;
    try {
      downloadTextFile(exportFileName(deck.name), formatDeckForExport(cards));
    } catch (err) {
      console.error("[manager] Exporting the deck failed:", err);
      setError("The deck could not be exported.");
    }
  };

  /** The same text to the clipboard, with a two-second confirmation. */
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

  /** Saves a renamed deck on blur, restoring the old name if the write fails. */
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

  if (loading || !deck) {
    return <DeckGate loading={loading} error={error} deck={deck} />;
  }

  return (
    <div className="manager">
      {/* A failure that happened after the deck loaded — a card that would not
          save, an export that was refused — reported without taking the screen
          away, because the edits are still here and still worth keeping. */}
      {error && <ErrorNotice message={error} />}
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
                {/* No onRemove: the text is editable here, but a snippet is
                    the source document's own and there is nothing on this
                    screen to write a replacement with. */}
                <CardAttachments media={card} />
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
