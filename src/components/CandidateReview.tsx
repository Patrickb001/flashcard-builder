import { useEffect, useMemo, useState } from 'react';
import type { CandidateCard, Deck, Flashcard } from '../types';
import type { DocumentSection } from '../lib/documentModel';
import { generateCandidates } from '../lib/flashcardGenerator';
import type { AiSettings, AiProgress } from '../lib/aiGenerator';
import { generateCandidatesWithAi } from '../lib/aiGenerator';
import { saveDeckWithCards } from '../db/db';

interface Props {
  sections: DocumentSection[];
  fileName: string;
  sourceType: 'pdf' | 'pptx' | 'md';
  ai: AiSettings;
  onSaved: (deckId: string) => void;
  onCancel: () => void;
}

/** What one parsed section is called, per source format. */
const UNIT_NOUN: Record<'pdf' | 'pptx' | 'md', string> = {
  pdf: 'page',
  pptx: 'slide',
  md: 'section',
};

function defaultDeckName(fileName: string): string {
  return fileName.replace(/\.(pdf|pptx|md|markdown|mdown|mkd)$/i, '');
}

export default function CandidateReview({
  sections,
  fileName,
  sourceType,
  ai,
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

    (async () => {
      try {
        const { cards, failedBatches, totalBatches, firstError } =
          await generateCandidatesWithAi(sections, ai, (p) => !cancelled && setProgress(p));
        if (cancelled) return;
        if (cards.length > 0) setCandidates(cards);

        if (failedBatches === 0) {
          setAiNotice(null);
        } else if (failedBatches === totalBatches) {
          // Every batch failed, so nothing here came from the model. This must
          // be unmissable: the cards look normal and the count alone will not
          // reveal that the selected feature never ran.
          setAiFailed(true);
          setAiNotice(
            `AI drafting did not run — these are rule-based cards. ${firstError ?? ''}`.trim()
          );
        } else {
          setAiFailed(false);
          setAiNotice(
            `${failedBatches} of ${totalBatches} batches fell back to rule-based drafting. ${firstError ?? ''}`.trim()
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
    };
  }, [sections, ai]);
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
    const cards: Flashcard[] = toSave.map((c) => ({
      id: crypto.randomUUID(),
      deckId,
      front: c.front.trim(),
      back: c.back.trim(),
      sourceLabel: c.sourceLabel,
      context: c.context,
      status: 'new',
      createdAt: now,
    }));

    await saveDeckWithCards(deck, cards);
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
