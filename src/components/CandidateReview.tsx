import { useEffect, useMemo, useState } from 'react';
import type { CandidateCard, Deck, Flashcard } from '../types';
import type { DocumentSection } from '../lib/documentModel';
import { generateCandidates } from '../lib/flashcardGenerator';
import type { AiSettings, AiProgress } from '../lib/aiGenerator';
import { generateCandidatesWithAi } from '../lib/aiGenerator';
import { saveDeckWithCards } from '../db/db';
import { Diagram, Snippet } from './CardMedia';
import type { SourceType } from './Uploader';

interface Props {
  sections: DocumentSection[];
  fileName: string;
  sourceType: SourceType;
  ai: AiSettings;
  /** Set when some sources were skipped, e.g. a page that could not be read. */
  notice?: string;
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

function defaultDeckName(fileName: string): string {
  return fileName.replace(/\.(pdf|pptx|md|markdown|mdown|mkd|html?|xhtml)$/i, '');
}

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
  // screen; AI drafting then replaces them when it finishes.
  const initialCandidates = useMemo(() => generateCandidates(sections), [sections]);
  const [candidates, setCandidates] = useState<CandidateCard[]>(initialCandidates);
  const [drafting, setDrafting] = useState(ai.mode !== 'off');
  const [progress, setProgress] = useState<AiProgress | null>(null);
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
            onProgress: (p) => !cancelled && setProgress(p),
            signal: controller.signal,
          });
        if (cancelled || aborted) return;
        if (cards.length > 0) setCandidates(cards);

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

  const includedCount = candidates.filter((c) => c.include).length;

  const updateCandidate = (index: number, patch: Partial<CandidateCard>) => {
    setCandidates((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  const removeCandidate = (index: number) => {
    setCandidates((prev) => prev.filter((_, i) => i !== index));
  };

  const addBlankCard = () => {
    setCandidates((prev) => [
      { front: '', back: '', sourceLabel: 'Manual', include: true },
      ...prev,
    ]);
  };

  const handleSave = async () => {
    const toSave = candidates.filter((c) => c.include && c.front.trim() && c.back.trim());
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
    const cards: Flashcard[] = toSave.map((c, index) => ({
      id: crypto.randomUUID(),
      deckId,
      front: c.front.trim(),
      back: c.back.trim(),
      sourceLabel: c.sourceLabel,
      context: c.context,
      // Snippets and diagrams travel with the card into the deck; the review
      // screen is where an unwanted one is taken off.
      frontCode: c.frontCode,
      backCode: c.backCode,
      image: c.image,
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

      {drafting && (
        <div className="drafting-banner">
          <span className="chalk-spinner small" aria-hidden="true" />
          <span>
            Claude is drafting cards
            {progress ? ` — batch ${progress.done} of ${progress.total}` : '…'}
          </span>
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
        {candidates.map((c, i) => (
          <li key={i} className={`candidate-row ${c.include ? '' : 'excluded'}`}>
            <input
              type="checkbox"
              checked={c.include}
              onChange={(e) => updateCandidate(i, { include: e.target.checked })}
              title="Include in deck"
            />
            <div className="candidate-fields">
              <textarea
                className="candidate-front"
                value={c.front}
                onChange={(e) => updateCandidate(i, { front: e.target.value })}
                placeholder="Front (question / term)"
                rows={2}
              />
              <textarea
                className="candidate-back"
                value={c.back}
                onChange={(e) => updateCandidate(i, { back: e.target.value })}
                placeholder="Back (answer / definition)"
                rows={2}
              />
              {(c.frontCode || c.backCode || c.image) && (
                <div className="candidate-media">
                  {c.frontCode && (
                    <div className="candidate-attachment">
                      <span className="attachment-tag">Shown with the question</span>
                      <Snippet code={c.frontCode} />
                      <button
                        className="ghost-btn small"
                        onClick={() => updateCandidate(i, { frontCode: undefined })}
                      >
                        Remove snippet
                      </button>
                    </div>
                  )}
                  {c.backCode && (
                    <div className="candidate-attachment">
                      <span className="attachment-tag">Shown with the answer</span>
                      <Snippet code={c.backCode} />
                      <button
                        className="ghost-btn small"
                        onClick={() => updateCandidate(i, { backCode: undefined })}
                      >
                        Remove snippet
                      </button>
                    </div>
                  )}
                  {c.image && (
                    <div className="candidate-attachment">
                      <span className="attachment-tag">Shown with the answer</span>
                      <Diagram image={c.image} />
                      <button
                        className="ghost-btn small"
                        onClick={() => updateCandidate(i, { image: undefined })}
                      >
                        Remove diagram
                      </button>
                    </div>
                  )}
                </div>
              )}
              <span className="candidate-meta">
                {c.context && <span className="topic-chip">{c.context}</span>}
                <span className="source-label">{c.sourceLabel}</span>
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
