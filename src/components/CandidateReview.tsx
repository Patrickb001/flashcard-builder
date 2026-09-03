import { useEffect, useState } from 'react';
import type { CandidateCard, Deck, Flashcard, SourceType } from '../types';
import type { DocumentSection } from '../lib/documentModel';
import { generateCandidates } from '../lib/flashcardGenerator';
import type { AiSettings } from '../lib/aiGenerator';
import type { BatchProgress } from '../lib/batchRunner';
import { generateCandidatesWithAi } from '../lib/aiGenerator';
import { saveDeckWithCards } from '../db/db';
import CardAttachments from './ui/CardAttachments';
import DraftingBanner from './ui/DraftingBanner';

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
  /** Fired with the new deck's id once it is safely in the database. */
  onSaved: (deckId: string) => void;
  onCancel: () => void;
}

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
 * Rule-based cards are computed synchronously so the list is never empty, and
 * the model's cards replace them when drafting finishes. That is deliberate —
 * a screen with something on it degrades to worse cards if the model fails,
 * where an empty one waiting on a network call degrades to nothing.
 *
 * Everything here is local until Save. Navigating away costs the session.
 */
export default function CandidateReview({
  sections,
  fileName,
  sourceType,
  ai,
  notice,
  onSaved,
  onCancel,
}: Props) {
  // Rule-based cards are computed immediately so there is always something on
  // screen; AI drafting then replaces them when it finishes. Computed in a lazy
  // initialiser rather than a memo: useState ignores its argument after mount,
  // so a memo here would be recomputed on every `sections` change and thrown
  // away, which reads as though the list tracks the prop when it does not.
  const [candidates, setCandidates] = useState<Draft[]>(() => withKeys(generateCandidates(sections)));
  const [drafting, setDrafting] = useState(ai.mode !== 'off');
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [aiFailed, setAiFailed] = useState(false);

  useEffect(() => {
    if (ai.mode === 'off') return;
    let cancelled = false;
    // A real signal, so navigating away actually stops the run. A local flag
    // alone left every remaining request in flight, drafting a document nobody
    // was waiting for and billing for it.
    const controller = new AbortController();

    (async () => {
      try {
        const { cards, failedSections, truncatedBatches, firstError, aborted } =
          await generateCandidatesWithAi(sections, ai, {
            onProgress: (batch) => !cancelled && setProgress(batch),
            signal: controller.signal,
          });
        if (cancelled || aborted) return;
        if (cards.length > 0) setCandidates(withKeys(cards));

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
        } else if (failed === sections.length) {
          // Nothing here came from the model. This must be unmissable: the
          // cards look normal and the count alone will not reveal that the
          // selected feature never ran.
          setAiFailed(true);
          setAiNotice(
            `AI drafting did not run — these are rule-based cards. ${why} ${firstError ?? ''}`.trim()
          );
        } else {
          setAiFailed(false);
          setAiNotice(
            `${failed} of ${sections.length} ${unit}${sections.length === 1 ? '' : 's'} fell back to rule-based drafting (${named}). ${why}`.trim()
          );
        }
      } catch (err) {
        if (!cancelled) {
          setAiFailed(true);
          setAiNotice(
            `AI drafting failed, so these are rule-based cards. ${
              err instanceof Error ? err.message : ''
            }`.trim()
          );
        }
      } finally {
        if (!cancelled) setDrafting(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sections, ai, sourceType]);
  const [deckName, setDeckName] = useState(defaultDeckName(fileName));
  const [saving, setSaving] = useState(false);

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
      createdAt: now,
      cardCount: toSave.length,
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
        Found {sections.length} {UNIT_NOUN[sourceType]}
        {sections.length === 1 ? '' : 's'} and drafted {candidates.length} candidate card
        {candidates.length === 1 ? '' : 's'}. Uncheck anything you don't want, edit the wording, or add
        your own before saving.
      </p>

      {drafting && <DraftingBanner activity="drafting cards" progress={progress} />}

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
        </div>
      )}

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
                <span className="source-label">{candidate.sourceLabel}</span>
              </span>
            </div>
            <button className="icon-btn danger" title="Remove" onClick={() => removeCandidate(i)}>
              ✕
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
