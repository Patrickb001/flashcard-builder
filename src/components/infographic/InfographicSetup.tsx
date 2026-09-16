import { useState } from "react";
import type { AiSettings } from "../../lib/aiGenerator";
import type { Flashcard, InfographicDetail } from "../../types";
import AiSettingsPanel from "../AiSettingsPanel";

interface Props {
  deckName: string;
  cards: Flashcard[];
  ai: AiSettings;
  onAiChange: (settings: AiSettings) => void;
  onGenerate: (detail: InfographicDetail, chosenCards: Flashcard[]) => void;
  onBack?: () => void;
}

const DETAIL_OPTIONS: { id: InfographicDetail; name: string; blurb: string; pageEstimate: string }[] = [
  { id: "basic", name: "Basic", blurb: "The core ideas only — a couple of blocks, a few points each.", pageEstimate: "~1 page" },
  { id: "standard", name: "Standard", blurb: "A fuller pass — most of the deck's key ideas, grouped and explained.", pageEstimate: "~1-2 pages" },
  { id: "detailed", name: "Detailed", blurb: "Thorough coverage across the deck, for a deeper study reference.", pageEstimate: "~3 pages" },
];

/**
 * Choosing how an infographic gets built: how much detail, and which cards.
 *
 * Mirrors QuizSetup's shape (a choice screen before a model call) but has no
 * "write missing questions" concept — an infographic is generated fresh
 * every time, never built up card-by-card.
 */
export default function InfographicSetup({
  deckName,
  cards,
  ai,
  onAiChange,
  onGenerate,
  onBack,
}: Props) {
  const [detail, setDetail] = useState<InfographicDetail>("standard");
  const [scope, setScope] = useState<"all" | "choose">("all");
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());

  const toggleCardSelected = (cardId: string) => {
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  };

  const chosenCards = scope === "all" ? cards : cards.filter((card) => selectedCardIds.has(card.id));
  const canGenerate = ai.mode !== "off" && chosenCards.length > 0;

  return (
    <div className="infographic-setup">
      {onBack && (
        <button type="button" className="ghost-btn small" onClick={onBack}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Back to your infographics
        </button>
      )}

      <p className="eyebrow">Infographic</p>
      <h2 className="infographic-setup-title">{deckName}</h2>

      <div className="field-group">
        <h3>How much detail?</h3>
        <div className="detail-options">
          {DETAIL_OPTIONS.map((option) => (
            <button
              type="button"
              key={option.id}
              className={`detail-card ${detail === option.id ? "active" : ""}`}
              onClick={() => setDetail(option.id)}
            >
              <h4>{option.name}</h4>
              <p>{option.blurb}</p>
              <span className="page-est">{option.pageEstimate}</span>
            </button>
          ))}
        </div>
        <p className="field-hint">
          A guide, not a hard limit — the model may return more or fewer blocks depending on how much the
          deck actually covers.
        </p>
      </div>

      <div className="field-group">
        <h3>Which cards?</h3>
        <div className="segmented">
          <button type="button" className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>
            All cards
          </button>
          <button type="button" className={scope === "choose" ? "active" : ""} onClick={() => setScope("choose")}>
            Choose cards
          </button>
        </div>
        <p className="field-hint">
          {cards.length} card{cards.length === 1 ? "" : "s"} in this deck.
        </p>

        {scope === "choose" && (
          <ul className="add-decks-list">
            {cards.map((card) => (
              <li key={card.id} className="add-decks-row">
                <label>
                  <input
                    type="checkbox"
                    checked={selectedCardIds.has(card.id)}
                    onChange={() => toggleCardSelected(card.id)}
                  />
                  <span>{card.front}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {ai.mode === "off" && <AiSettingsPanel settings={ai} onChange={onAiChange} />}

      <div className="form-actions">
        <button
          type="button"
          className="primary-btn"
          disabled={!canGenerate}
          onClick={() => onGenerate(detail, chosenCards)}
        >
          Generate infographic
        </button>
      </div>
    </div>
  );
}
