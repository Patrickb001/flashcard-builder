import { useEffect, useState } from 'react';
import type { CandidateCard, Deck, Flashcard, Folder, SourceType } from '../types';
import type { DocumentSection, OcrPage } from '../lib/documentModel';
import { generateCandidates } from '../lib/flashcardGenerator';
import type { AiSettings } from '../lib/aiGenerator';
import type { BatchProgress } from '../lib/batchRunner';
import { generateCandidatesWithAi } from '../lib/aiGenerator';
import { transcribePagesWithAi } from '../lib/ocrGenerator';
import { createFolder, getAllFolders, saveDeckWithCards } from '../db/db';
import { UNFILED, cleanFolderName, folderErrorMessage, sortFolders } from '../lib/deckFolders';
import CardAttachments from './ui/CardAttachments';
import ErrorNotice from './ui/ErrorNotice';
import DraftingBanner from './ui/DraftingBanner';
import ProgressBar from './ui/ProgressBar';

interface Props {
  /**
   * The parsed document. Cards are drafted from this on mount, and the identity
   * of the array is what decides whether drafting runs again — so it must be
   * stable across renders, or a paid model call repeats.
   */
  sections: DocumentSection[];
  /** Seeds the deck name, minus its extension. */
  fileName: string;
  /** Names the unit a section is, so the notices can say "page" or "slide". */
  sourceType: SourceType;
  /** Whether to draft with the model, and how to reach it. */
  ai: AiSettings;
  /** Set when some sources were skipped, e.g. a page that could not be read. */
  notice?: string;
  /** The address(es) read, for a deck built from one or more URLs. */
  sourceUrls?: string[];
  /**
   * Scanned/photographed pages a PDF upload found no text on. Only entries
   * with `image` set (ocrEnabled was true when the file was parsed) are ever
   * transcribed; undefined or empty for every non-PDF source.
   */
  ocrPages?: OcrPage[];
  /**
   * The folder to preselect, from the library view the upload started in.
   * Ignored when no folder with this id exists once the folders have loaded.
   */
  folderId?: string;
  /** Fired with the new deck's id once it is safely in the database. */
  onSaved: (deckId: string) => void;
  onCancel: () => void;
}

/** The folder select's "New folder…" option. Not a UUID, so never a real folder id. */
const NEW_FOLDER = '__new-folder__';

/** What one parsed section is called, per source format. */
const UNIT_NOUN: Record<SourceType, string> = {
  pdf: 'page',
  pptx: 'slide',
  md: 'section',
  html: 'section',
};

/**
 * A candidate plus a key that survives the list being edited.
 *
 * The key exists only for React. Rows can be removed, so an index key makes the
 * row below inherit the removed row's DOM node — and with it the caret of
 * whoever was typing in it.
 */
type Draft = CandidateCard & { key: string };

/** Tags freshly drafted candidates so each row keeps its identity. */
function withKeys(cards: CandidateCard[]): Draft[] {
  return cards.map((card) => ({ ...card, key: crypto.randomUUID() }));
}

/** The file name with its extension removed, as the deck's opening name. */
function defaultDeckName(fileName: string): string {
  return fileName.replace(/\.(pdf|pptx|md|markdown|mdown|mkd|html?|xhtml)$/i, '');
}

/**
 * Step two: check the drafted cards, then save them as a deck.
 *
 * When AI drafting is on, the list starts empty and fills in with the
 * model's cards when drafting finishes — rule-based cards are never shown
 * automatically. A section the model couldn't cover gets its deterministic
 * fallback computed eagerly but held back in `fallbackCards`, offered only
 * through the "add rule-based cards" button, and visibly badged once added.
 * That is deliberate: a silently weaker card mixed into an AI-drafted deck is
 * harder to notice than one the user chose to add.
 *
 * With AI off there is no run to wait for, so the rule-based draft is shown
 * immediately, exactly as before.
 *
 * Everything here is local until Save. Navigating away costs the session.
 */
export default function CandidateReview({
  sections,
  fileName,
  sourceType,
  ai,
  notice,
  sourceUrls,
  ocrPages,
  folderId,
  onSaved,
  onCancel,
}: Props) {
  // With AI on, the list starts empty and fills in once drafting resolves —
  // rule-based cards are opt-in (see `fallbackCards`), not a placeholder.
  // With AI off there is nothing to wait for, so the rule-based draft is
  // computed immediately, as it always was. Computed in a lazy initialiser
  // rather than a memo: useState ignores its argument after mount, so a memo
  // here would be recomputed on every `sections` change and thrown away,
  // which reads as though the list tracks the prop when it does not.
  const [candidates, setCandidates] = useState<Draft[]>(() =>
    ai.mode === 'off' ? withKeys(generateCandidates(sections)) : []
  );
  const [drafting, setDrafting] = useState(ai.mode !== 'off');
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [aiFailed, setAiFailed] = useState(false);
  // True only while scanned pages are being transcribed — a phase that runs
  // before card drafting, and reuses the same banner/progress components.
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<BatchProgress | null>(null);
  const [ocrNotice, setOcrNotice] = useState<string | null>(null);
  // Held back rather than merged into `candidates` until the user asks for
  // them via the button below the banner.
  const [fallbackCards, setFallbackCards] = useState<CandidateCard[]>([]);

  useEffect(() => {
    if (ai.mode === 'off') return;
    let cancelled = false;
    // A real signal, so navigating away actually stops the run. A local flag
    // alone left every remaining request in flight, drafting a document nobody
    // was waiting for and billing for it.
    const controller = new AbortController();

    (async () => {
      // Reassigned once OCR resolves (below); the emergency fallback in catch
      // reads whatever this holds, so it is declared outside the try block
      // rather than as a `const` inside it.
      let workingSections = sections;
      try {
        // Scanned pages, if any, are transcribed first. From card drafting's
        // point of view below, an OCR'd page becomes indistinguishable from
        // any other section — it can get real AI-drafted cards, and a
        // rule-based fallback too if its own card drafting specifically fails.
        const toOcr = (ocrPages ?? []).filter((p) => p.image);
        if (toOcr.length > 0) {
          setOcrRunning(true);
          const ocrResult = await transcribePagesWithAi(toOcr, ai, {
            onProgress: (batch) => !cancelled && setOcrProgress(batch),
            signal: controller.signal,
          });
          if (cancelled || ocrResult.aborted) return;
          setOcrRunning(false);
          workingSections = [...sections, ...ocrResult.sections].sort(
            (a, b) => (a.pageNum ?? 0) - (b.pageNum ?? 0)
          );
          if (ocrResult.failedPages.length > 0) {
            setOcrNotice(
              `${ocrResult.failedPages.length} of ${toOcr.length} scanned page${toOcr.length === 1 ? '' : 's'} could not be read.`
            );
          }
        }

        const { cards, fallbackCards: fallback, failedSections, truncatedBatches, firstError, aborted } =
          await generateCandidatesWithAi(workingSections, ai, {
            onProgress: (batch) => !cancelled && setProgress(batch),
            signal: controller.signal,
          });
        if (cancelled || aborted) return;
        // Always applied, including when empty: an empty AI result must
        // clear the (already-empty) list, not silently keep whatever was
        // there before, now that nothing is pre-seeded to fall back on.
        setCandidates(withKeys(cards));
        setFallbackCards(fallback);

        const unit = UNIT_NOUN[sourceType];
        // Reported in the document's own units. This counted batches before,
        // so a 16-page PDF that lost three batches of four said "3 of 4" and
        // read as though three quarters of the file had been unreadable.
        const failed = failedSections.length;
        // Named, but not all of them: a deck where thirty pages fell back would
        // otherwise put thirty labels in a banner nobody can read.
        const named =
          failedSections.length > 6
            ? `${failedSections.slice(0, 6).join(', ')} and ${failedSections.length - 6} more`
            : failedSections.join(', ');
        // A reply cut off by the length limit is the tool's fault and says so,
        // rather than being reported as though the model had nothing to offer.
        const why = truncatedBatches > 0
          ? 'The model ran out of room mid-answer on a dense part of the document.'
          : '';

        if (failed === 0) {
          setAiNotice(null);
        } else if (failed === workingSections.length) {
          // Nothing here came from the model. This must be unmissable: the
          // cards look normal and the count alone will not reveal that the
          // selected feature never ran.
          setAiFailed(true);
          setAiNotice(
            `AI drafting did not run. ${why} ${firstError ?? ''}`.trim()
          );
        } else {
          setAiFailed(false);
          setAiNotice(
            `${failed} of ${workingSections.length} ${unit}${workingSections.length === 1 ? '' : 's'} fell back to rule-based drafting (${named}). ${why}`.trim()
          );
        }
      } catch (err) {
        if (!cancelled) {
          setAiFailed(true);
          // A hard failure means generateCandidatesWithAi (or the OCR step
          // before it) never returned at all, so there is no fallbackCards to
          // read from it — computed fresh here for whatever sections were
          // known at the point of failure, or the button below would have
          // nothing to offer and the user would be left with an empty list.
          setFallbackCards(
            generateCandidates(workingSections).map((card) => ({ ...card, origin: 'rule-based' as const }))
          );
          setAiNotice(
            `AI drafting failed. ${err instanceof Error ? err.message : ''}`.trim()
          );
        }
      } finally {
        if (!cancelled) {
          setDrafting(false);
          setOcrRunning(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sections, ocrPages, ai, sourceType]);
  const [deckName, setDeckName] = useState(defaultDeckName(fileName));
  const [saving, setSaving] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  // Unfiled until the folders load and the requested one is confirmed to exist.
  const [folderChoice, setFolderChoice] = useState<string>(UNFILED);
  const [folderError, setFolderError] = useState<string | null>(null);

  // A failed read leaves only Unfiled and "New folder…" to choose from. Saving
  // still works, so a folder problem never costs anyone their reviewed cards.
  useEffect(() => {
    let cancelled = false;
    getAllFolders()
      .then((all) => {
        if (cancelled) return;
        setFolders(all);
        if (folderId && all.some((folder) => folder.id === folderId)) {
          // Only if nothing has been picked yet, so a slow read cannot undo a choice.
          setFolderChoice((current) => (current === UNFILED ? folderId : current));
        }
      })
      .catch((err) => {
        console.error('[review] Could not read the folders:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [folderId]);

  /** Applies the folder select, creating a folder first when "New folder…" was picked. */
  const handleFolderSelect = async (value: string) => {
    setFolderError(null);
    if (value !== NEW_FOLDER) {
      setFolderChoice(value);
      return;
    }
    // The select is controlled, so cancelling leaves it on the previous choice.
    const name = prompt('Name the new folder');
    if (name === null || !cleanFolderName(name)) return;
    try {
      const folder = await createFolder(name);
      setFolders((prev) => [...prev, folder]);
      setFolderChoice(folder.id);
    } catch (err) {
      console.error('[review] Creating the folder failed:', err);
      setFolderError(folderErrorMessage(err, 'The folder could not be created.'));
    }
  };

  const includedCount = candidates.filter((candidate) => candidate.include).length;

  /** Applies an edit to one candidate, leaving the rest untouched. */
  const updateCandidate = (index: number, patch: Partial<CandidateCard>) => {
    setCandidates((prev) =>
      prev.map((candidate, i) => (i === index ? { ...candidate, ...patch } : candidate))
    );
  };

  /** Drops a candidate entirely, as opposed to unchecking it. */
  const removeCandidate = (index: number) => {
    setCandidates((prev) => prev.filter((_, i) => i !== index));
  };

  /** Appends the held-back rule-based cards to the bottom of the list, and clears them. */
  const addFallbackCards = () => {
    setCandidates((prev) => [...prev, ...withKeys(fallbackCards)]);
    setFallbackCards([]);
  };

  /** Opens an empty card at the top of the list, for writing one by hand. */
  const addBlankCard = () => {
    setCandidates((prev) => [
      { front: '', back: '', sourceLabel: 'Manual', include: true, key: crypto.randomUUID() },
      ...prev,
    ]);
  };

  /**
   * Turns the checked candidates into a saved deck and hands back its id.
   *
   * Blank fronts or backs are dropped here rather than blocking the save: an
   * empty row is someone who started a card and changed their mind, not an error
   * worth stopping on.
   */
  const handleSave = async () => {
    const toSave = candidates.filter(
      (candidate) => candidate.include && candidate.front.trim() && candidate.back.trim()
    );
    if (toSave.length === 0) return;
    setSaving(true);

    const deckId = crypto.randomUUID();
    const now = Date.now();
    const deck: Deck = {
      id: deckId,
      name: deckName.trim() || 'Untitled deck',
      sourceFileName: fileName,
      sourceType,
      sourceUrls,
      createdAt: now,
      cardCount: toSave.length,
      // Left off entirely for Unfiled, so the record matches a deck saved
      // before folders existed rather than carrying an undefined key.
      ...(folderChoice === UNFILED ? {} : { folderId: folderChoice }),
    };
    // `order` is what preserves the review screen's order into the deck. Every
    // card here shares one `createdAt`, so nothing else in the record can say
    // which came first.
    const cards: Flashcard[] = toSave.map((candidate, index) => ({
      id: crypto.randomUUID(),
      deckId,
      front: candidate.front.trim(),
      back: candidate.back.trim(),
      sourceLabel: candidate.sourceLabel,
      context: candidate.context,
      // Snippets and diagrams travel with the card into the deck; the review
      // screen is where an unwanted one is taken off.
      frontCode: candidate.frontCode,
      backCode: candidate.backCode,
      image: candidate.image,
      status: 'new',
      createdAt: now,
      order: index,
    }));

    try {
      await saveDeckWithCards(deck, cards);
    } catch (err) {
      // Unguarded, a rejection here destroyed a whole hand-edited review
      // session and left the button stuck on "Saving…".
      console.error('[review] Saving the deck failed:', err);
      setAiFailed(true);
      setAiNotice(
        'The deck could not be saved to this browser. Your edits are still here - try saving again.'
      );
      setSaving(false);
      return;
    }
    setSaving(false);
    onSaved(deckId);
  };

  return (
    <div className="review">
      <p className="eyebrow">Step 2 of 2</p>
      <h1>Check the draft deck</h1>
      <p className="muted">
        Found {sections.length + (ocrPages?.length ?? 0)} {UNIT_NOUN[sourceType]}
        {sections.length + (ocrPages?.length ?? 0) === 1 ? '' : 's'} and drafted {candidates.length} candidate card
        {candidates.length === 1 ? '' : 's'}. Uncheck anything you don't want, edit the wording, or add
        your own before saving.
      </p>

      {ocrRunning && (
        <>
          <DraftingBanner activity="reading scanned pages" progress={ocrProgress} />
          <ProgressBar fraction={ocrProgress ? ocrProgress.done / ocrProgress.total : 0} />
        </>
      )}

      {drafting && !ocrRunning && (
        <>
          <DraftingBanner activity="drafting cards" progress={progress} />
          <ProgressBar fraction={progress ? progress.done / progress.total : 0} />
        </>
      )}

      {ocrNotice && (
        <div className="ai-notice partial" role="status">
          <strong>Some scanned pages could not be read</strong>
          <span>{ocrNotice}</span>
        </div>
      )}

      {notice && (
        <div className="ai-notice partial" role="status">
          <strong>Some sources were skipped</strong>
          <span>{notice}</span>
        </div>
      )}

      {aiNotice && (
        <div className={`ai-notice ${aiFailed ? 'failed' : 'partial'}`} role="alert">
          <strong>{aiFailed ? 'AI drafting did not run' : 'Partial AI drafting'}</strong>
          <span>{aiNotice}</span>
          {fallbackCards.length > 0 && (
            <button className="ghost-btn small" onClick={addFallbackCards}>
              Add {fallbackCards.length} rule-based card{fallbackCards.length === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}

      {drafting && !ocrRunning && candidates.length === 0 && fallbackCards.length === 0 && (
        <p className="muted">Waiting for the first cards…</p>
      )}

      <div className="deck-save-fields">
        <div className="deck-name-row">
          <label htmlFor="deck-name">Deck name</label>
          <input
            id="deck-name"
            type="text"
            value={deckName}
            onChange={(e) => setDeckName(e.target.value)}
            placeholder="Name this deck"
          />
        </div>
        <div className="deck-name-row deck-folder-row">
          <label htmlFor="deck-folder">Folder</label>
          {/* Always A–Z, whatever the library is sorted by. */}
          <select
            id="deck-folder"
            className="folder-select"
            value={folderChoice}
            onChange={(e) => handleFolderSelect(e.target.value)}
          >
            <option value={UNFILED}>Unfiled</option>
            {sortFolders(folders, 'name').map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
            <option value={NEW_FOLDER}>New folder…</option>
          </select>
          {folderError && <ErrorNotice message={folderError} />}
        </div>
      </div>

      <div className="review-toolbar">
        <span className="muted small">
          {includedCount} of {candidates.length} selected
        </span>
        <button className="ghost-btn small" onClick={addBlankCard}>
          + Add blank card
        </button>
      </div>

      {candidates.length === 0 && (
        <p className="muted">No candidates left — add a blank card above if you'd like to write your own.</p>
      )}

      <ul className="candidate-list">
        {candidates.map((candidate, i) => (
          <li
            key={candidate.key}
            className={`candidate-row ${candidate.include ? '' : 'excluded'}`}
          >
            <input
              type="checkbox"
              checked={candidate.include}
              onChange={(e) => updateCandidate(i, { include: e.target.checked })}
              title="Include in deck"
            />
            <div className="candidate-fields">
              <textarea
                className="candidate-front"
                value={candidate.front}
                onChange={(e) => updateCandidate(i, { front: e.target.value })}
                placeholder="Front (question / term)"
                rows={2}
              />
              <textarea
                className="candidate-back"
                value={candidate.back}
                onChange={(e) => updateCandidate(i, { back: e.target.value })}
                placeholder="Back (answer / definition)"
                rows={2}
              />
              <CardAttachments
                media={candidate}
                onRemove={(attachment) => updateCandidate(i, { [attachment]: undefined })}
              />
              <span className="candidate-meta">
                {candidate.context && <span className="topic-chip">{candidate.context}</span>}
                {candidate.origin === 'rule-based' && (
                  <span className="topic-chip rule-based">Rule-based</span>
                )}
                <span className="source-label">{candidate.sourceLabel}</span>
              </span>
            </div>
            <button className="icon-btn danger" title="Remove" onClick={() => removeCandidate(i)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </li>
        ))}
      </ul>

      <div className="form-actions sticky">
        <button className="ghost-btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button className="primary-btn" onClick={handleSave} disabled={saving || includedCount === 0}>
          {saving ? 'Saving…' : `Save deck (${includedCount})`}
        </button>
      </div>
    </div>
  );
}
