import { useEffect, useRef, useState } from "react";
import type { Flashcard, Folder } from "../types";
import {
  addCard,
  deleteCard,
  getAllFolders,
  moveDeckToFolder,
  renameDeck,
  updateCardContent,
} from "../db/db";
import { confirmAndDeleteDeck } from "../lib/deckActions";
import { UNFILED, folderOf, sortFolders } from "../lib/deckFolders";
import { deckNameForUrl } from "../lib/pageSource";
import { describeDue, describeSchedule, scheduleState } from "../lib/scheduling";
import { sessionPreview } from "../lib/studyQueue";
import {
  downloadTextFile,
  exportFileName,
  formatDeckForExport,
} from "../lib/deckExport";
import { useDeck } from "./useDeck";
import CardAttachments from "./ui/CardAttachments";
import DeckGate from "./ui/DeckGate";
import ErrorNotice from "./ui/ErrorNotice";
import {
  ChartIcon,
  CheckIcon,
  ClipboardCheckIcon,
  CopyIcon,
  DownloadIcon,
  LayersIcon,
  PlayIcon,
  PlusIcon,
} from "./ui/Icons";

interface Props {
  /** The deck to manage. Everything on screen is read from it on mount. */
  deckId: string;
  /** A review session: due cards, then some new ones. */
  onStudy: (deckId: string) => void;
  /** Every card in the deck, for cramming. */
  onStudyAll: (deckId: string) => void;
  onTest: (deckId: string) => void;
  onInfographic: (deckId: string) => void;
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
  onStudyAll,
  onTest,
  onInfographic,
  onDeckDeleted,
}: Props) {
  const { deck, setDeck, cards, setCards, loading, error, setError, reload } =
    useDeck(deckId);
  const [nameDraft, setNameDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [foldersLoaded, setFoldersLoaded] = useState(false);

  // Read here rather than through useDeck, which the study and test screens
  // share and which have no use for folders. `foldersLoaded` gates the
  // select's `disabled` prop, not its displayed value — a slow read shows a
  // greyed-out control, never a wrong one. A failed read is the one case
  // that must NOT flip the select on: `folders` would still be `[]`, so
  // folderOf would report a filed deck as Unfiled — a false statement about
  // where the deck actually lives, not just a smaller set of choices. So a
  // failure keeps the select disabled and says so, rather than re-enabling
  // it over a value it can no longer vouch for.
  useEffect(() => {
    let cancelled = false;
    getAllFolders()
      .then((all) => {
        if (cancelled) return;
        setFolders(all);
        setFoldersLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[manager] Could not read the folders:", err);
        setError("This deck's folder could not be read.");
      });
    return () => {
      cancelled = true;
    };
  }, [setError]);
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

  /**
   * Writes one edited card's text. A failed write leaves the edit on screen.
   *
   * Text only, through updateCardContent: writing back the whole in-memory
   * card would also write back the schedule this screen loaded, undoing any
   * study done since in another tab.
   */
  const persistCard = async (card: Flashcard) => {
    try {
      await updateCardContent(card.id, { front: card.front, back: card.back });
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
    // Omits the key for Unfiled rather than setting it to undefined — this
    // value never reaches storage (every db.ts writer re-reads the record
    // inside its own transaction), but every other write of Unfiled in this
    // codebase uses the same omit-the-key shape, and 'folderId' in deck is
    // exactly what several IndexedDB tests check for.
    const optimistic = { ...deck };
    if (folderId === null) delete optimistic.folderId;
    else optimistic.folderId = folderId;
    setDeck(optimistic);
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

  // Read once per render; the labels below are day-granular, so a screen left
  // open across midnight is only stale until its next render.
  const now = Date.now();
  const session = sessionPreview(cards, now);
  const hasCards = cards.length > 0;
  const caughtUp = hasCards && session.due + session.fresh === 0;
  const cardCount = `${cards.length} card${cards.length === 1 ? "" : "s"} in this deck`;

  // What the next review session holds, in the words the study screen will
  // bear out: due cards, then new ones up to the session limit.
  let sessionHeadline: string;
  if (!hasCards) sessionHeadline = "No cards yet";
  else if (caughtUp) sessionHeadline = "All caught up";
  else if (session.due > 0 && session.fresh > 0) sessionHeadline = `${session.due} due · ${session.fresh} new`;
  else if (session.due > 0) sessionHeadline = `${session.due} card${session.due === 1 ? "" : "s"} due`;
  else sessionHeadline = `${session.fresh} new card${session.fresh === 1 ? "" : "s"}`;

  let sessionDetail: string;
  if (!hasCards) sessionDetail = "Add a card below to start studying.";
  else if (caughtUp && session.nextDue !== null)
    sessionDetail = `Next review ${describeDue(session.nextDue, now)} · ${cardCount}`;
  else if (session.due === 0) sessionDetail = `0 due for review · ${cardCount}`;
  else sessionDetail = cardCount;

  return (
    <div className="manager">
      {/* A failure that happened after the deck loaded — a card that would not
          save, an export that was refused — reported without taking the screen
          away, because the edits are still here and still worth keeping. */}
      {error && <ErrorNotice message={error} />}
      <div className="manager-header">
        <p className="eyebrow">Manage cards</p>
        <input
          className="deck-title-input"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          aria-label="Deck name"
        />
        <div className="manager-meta">
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
          <span className="manager-meta-divider" aria-hidden="true" />
          {/* A deck from web pages links back to them; one from a file names
              the file, which is the only trace of where it came from. */}
          {deck.sourceUrls && deck.sourceUrls.length > 0 ? (
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
          ) : (
            <p className="source-links">From {deck.sourceFileName}</p>
          )}
        </div>
      </div>

      {/* Studying is one choice with two scopes, so it is one control: the
          review session, and "All cards" joined to its side. Test and
          infographic are tools, one step quieter, below it. */}
      <section className="study-panel" aria-label="Study">
        <div className="study-panel-summary">
          <span className="study-panel-label">Next session</span>
          <span className="study-panel-headline">{sessionHeadline}</span>
          <span className="study-panel-detail">{sessionDetail}</span>
        </div>
        <div className="split-btn">
          {caughtUp ? (
            // Nothing is due, so the only session on offer is the whole deck:
            // one button, not a review button that leads to "All caught up".
            <button className="primary-btn" onClick={() => onStudyAll(deckId)}>
              <PlayIcon />
              Study anyway
            </button>
          ) : (
            <>
              <button className="primary-btn" onClick={() => onStudy(deckId)} disabled={!hasCards}>
                <PlayIcon />
                Start studying
              </button>
              <button
                className="secondary-btn"
                onClick={() => onStudyAll(deckId)}
                disabled={!hasCards}
                title="Study every card in the deck, whether it is due or not"
              >
                <LayersIcon />
                All cards
              </button>
            </>
          )}
        </div>
      </section>

      <div className="manager-tools">
        {/* One entry. The kind of test is chosen on the setup screen, which
            has to offer the picker anyway, and nothing is written until the
            button there is pressed — so there is nothing to decide this early. */}
        <button className="secondary-btn" onClick={() => onTest(deckId)} disabled={!hasCards}>
          <ClipboardCheckIcon />
          Test this deck
        </button>
        <button className="secondary-btn" onClick={() => onInfographic(deckId)} disabled={!hasCards}>
          <ChartIcon />
          {/* The short form is for phones, where two tools share one row. */}
          <span className="label-full">Create infographic</span>
          <span className="label-short" aria-hidden="true">
            Infographic
          </span>
        </button>
      </div>

      <div className="manager-cards-header">
        <h2 className="manager-cards-title">
          Cards <span className="count-chip">{cards.length}</span>
        </h2>
        <div className="manager-toolbar">
          <button className="secondary-btn small" onClick={handleAdd}>
            <PlusIcon />
            Add card
          </button>
          <span className="toolbar-divider" aria-hidden="true" />
          {/* On a phone these two collapse to their icons; the aria-label
              keeps each one named for a screen reader either way. */}
          <button
            className="ghost-btn small collapsible-label"
            onClick={handleExport}
            disabled={!hasCards}
            title="Save the deck as a text file"
            aria-label="Download .txt"
          >
            <DownloadIcon />
            <span className="btn-label">Download .txt</span>
          </button>
          <button
            className="ghost-btn small collapsible-label"
            onClick={handleCopy}
            disabled={!hasCards}
            title="Copy the deck as delimited text"
            aria-label={copied ? "Copied" : "Copy"}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            <span className="btn-label">{copied ? "Copied" : "Copy"}</span>
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
                  <span
                    className={`source-label schedule-${scheduleState(card, now)}`}
                  >
                    {card.sourceLabel} · {describeSchedule(card, now)}
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
