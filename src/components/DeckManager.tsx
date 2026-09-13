import { useEffect, useRef, useState } from "react";
import type { Flashcard, Folder } from "../types";
import {
  addCard,
  deleteCard,
  getAllFolders,
  moveDeckToFolder,
  renameDeck,
  updateCard,
} from "../db/db";
import { confirmAndDeleteDeck } from "../lib/deckActions";
import { UNFILED, folderOf, sortFolders } from "../lib/deckFolders";
import { deckNameForUrl } from "../lib/pageSource";
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
  onStudy,
  onTest,
  onDeckDeleted,
}: Props) {
  const { deck, setDeck, cards, setCards, loading, error, setError, reload } =
    useDeck(deckId);
  const [nameDraft, setNameDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [foldersLoaded, setFoldersLoaded] = useState(false);

  // Read here rather than through useDeck, which the study and test screens
  // share and which have no use for folders. The select stays disabled until
  // this settles, so a deck already in a folder never shows as Unfiled first.
  // A failed read leaves only Unfiled to choose; the cards stay editable.
  useEffect(() => {
    let cancelled = false;
    getAllFolders()
      .then((all) => {
        if (!cancelled) setFolders(all);
      })
      .catch((err) => {
        console.error("[manager] Could not read the folders:", err);
      })
      .finally(() => {
        if (!cancelled) setFoldersLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
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
      prev.map((existing) =>
        existing.id === id ? { ...existing, [field]: value } : existing,
      ),
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
        typeof existing.order === "number" && existing.order > max
          ? existing.order
          : max,
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

  /**
   * Files the deck in the chosen folder, putting the select back if the write fails.
   *
   * Shown as moved straight away; the write is one small transaction, and a
   * failure is rare enough that snapping back with a notice is the better trade.
   */
  const handleFolderChange = async (value: string) => {
    if (!deck) return;
    const folderId = value === UNFILED ? null : value;
    const previous = deck;
    setDeck({ ...deck, folderId: folderId ?? undefined });
    try {
      await moveDeckToFolder(deckId, folderId);
    } catch (err) {
      console.error("[manager] Moving the deck failed:", err);
      setError("The deck could not be moved to that folder.");
      setDeck(previous);
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
          <div className="manager-folder-row">
            <label htmlFor="deck-folder">Folder</label>
            {/* Always A–Z, whatever the library is sorted by: a dropdown is
                scanned for a name, not browsed by age. */}
            <select
              id="deck-folder"
              className="folder-select"
              value={folderOf(deck, new Set(folders.map((folder) => folder.id)))}
              disabled={!foldersLoaded}
              onChange={(e) => handleFolderChange(e.target.value)}
            >
              <option value={UNFILED}>Unfiled</option>
              {sortFolders(folders, "name").map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>
          </div>
          <p className="muted small">
            {cards.length} card{cards.length === 1 ? "" : "s"} · from{" "}
            {deck.sourceFileName}
          </p>
          {deck.sourceUrls && deck.sourceUrls.length > 0 && (
            <p className="source-links">
              Source{deck.sourceUrls.length === 1 ? "" : "s"}:{" "}
              {deck.sourceUrls.map((url, i) => (
                <span key={url}>
                  {i > 0 && ", "}
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    {deckNameForUrl(url)}
                  </a>
                </span>
              ))}
            </p>
          )}
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
            {copied ? (
              <>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                Copied
              </>
            ) : (
              "Copy"
            )}
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
                  onBlur={() => persistCard(card)}
                  placeholder="Front"
                />
                <textarea
                  className="candidate-back"
                  value={card.back}
                  rows={2}
                  onChange={(e) =>
                    handleFieldChange(card.id, "back", e.target.value)
                  }
                  onBlur={() => persistCard(card)}
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
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
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
