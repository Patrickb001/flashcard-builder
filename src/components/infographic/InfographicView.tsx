import type { Infographic } from "../../types";
import { INFOGRAPHIC_ICONS } from "./icons";

interface Props {
  infographic: Infographic;
  totalCardCount: number;
  onBack: () => void;
  onDelete: () => void;
}

const DETAIL_LABEL: Record<Infographic["detail"], string> = {
  basic: "Basic",
  standard: "Standard",
  detailed: "Detailed",
};

/**
 * One saved infographic in full: title, then every section as an icon,
 * heading and its bullet points.
 *
 * The dashed page-break divider every 3 sections is presentational only —
 * see the spec's "Pagination is presentation, not data" note. Nothing about
 * where a section actually falls on a page is stored; this is purely a
 * visual cue that content of this length would run to more than one page.
 */
export default function InfographicView({ infographic, totalCardCount, onBack, onDelete }: Props) {
  const handleDelete = () => {
    if (confirm(`Delete "${infographic.title}"? This can't be undone.`)) {
      onDelete();
    }
  };

  const usedAllCards = infographic.cardIds.length === totalCardCount;

  return (
    <div>
      <div className="infographic-doc">
        <div className="infographic-doc-header">
          <p className="deck-eyebrow">
            {DETAIL_LABEL[infographic.detail]} ·{" "}
            {usedAllCards ? `all ${totalCardCount} cards` : `${infographic.cardIds.length} cards`}
          </p>
          <h2>{infographic.title}</h2>
        </div>

        <div className="infographic-sections">
          {infographic.sections.map((section, index) => (
            <div key={index}>
              {index > 0 && index % 3 === 0 && (
                <div className="page-break">Page {Math.floor(index / 3) + 1}</div>
              )}
              <div className="infographic-section">
                <div className="infographic-section-icon">{INFOGRAPHIC_ICONS[section.icon]}</div>
                <div className="infographic-section-body">
                  <h4>{section.heading}</h4>
                  <ul>
                    {section.points.map((point, i) => (
                      <li key={i}>{point}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="view-actions">
        <button type="button" className="ghost-btn" onClick={onBack}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 6l-6 6 6 6" />
          </svg>
          Back to infographics
        </button>
        <button type="button" className="ghost-btn" onClick={handleDelete} style={{ color: "var(--danger)" }}>
          Delete this infographic
        </button>
      </div>
    </div>
  );
}
