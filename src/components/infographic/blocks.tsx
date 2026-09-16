import type { InfographicBlock } from "../../types";
import { INFOGRAPHIC_ICONS } from "./icons";

const CALLOUT_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3 2 20h20L12 3Z" />
    <path d="M12 10v4M12 17h.01" />
  </svg>
);

const STAT_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="8.2" />
    <path d="M9 12h6M12 9v6" />
  </svg>
);

const TABLE_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M3.5 10h17M9.5 4.5v15" />
  </svg>
);

const COMPARE_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 3v18M16 3v18M4 8h4M16 8h4M4 16h4M16 16h4" />
  </svg>
);

const STEPS_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 6h14M5 12h14M5 18h9" />
  </svg>
);

/**
 * One block, dispatched by its `type`. Every case is a typed props object
 * into typed JSX — nothing here ever touches the model's own markup,
 * because the model never sends any (see infographicPrompt.ts's clamped
 * schema, which only ever returns structured JSON).
 *
 * bullets/timeline take their icon from the model-chosen InfographicIcon
 * enum; every other type gets one icon fixed here in code — see the
 * Decisions table in the design spec for why.
 */
export default function InfographicBlockCard({ block }: { block: InfographicBlock }) {
  switch (block.type) {
    case "bullets":
      return (
        <div className="infographic-section">
          <div className="infographic-section-icon">{INFOGRAPHIC_ICONS[block.icon]}</div>
          <div className="infographic-section-body">
            <h4>{block.heading}</h4>
            <ul>
              {block.points.map((point, i) => (
                <li key={i}>{point}</li>
              ))}
            </ul>
          </div>
        </div>
      );

    case "callout":
      return (
        <div className={`infographic-section infographic-callout${block.tone === "info" ? " info" : ""}`}>
          <div className="infographic-section-icon">{CALLOUT_ICON}</div>
          <div className="infographic-section-body">
            <p>{block.text}</p>
          </div>
        </div>
      );

    case "stat":
      return (
        <div className="infographic-section" aria-label={`${block.value}${block.unit ?? ""}: ${block.caption}`}>
          <div className="infographic-section-icon">{STAT_ICON}</div>
          <div className="infographic-section-body">
            <h4>{block.heading}</h4>
            <div className="infographic-stat-value">
              {block.value}
              {block.unit && <span className="unit">{block.unit}</span>}
            </div>
            <p className="infographic-stat-caption">{block.caption}</p>
          </div>
        </div>
      );

    case "quote":
      return (
        <div className="infographic-section infographic-quote">
          <div className="infographic-quote-mark" aria-hidden="true">
            &ldquo;
          </div>
          <p className="infographic-quote-text">{block.text}</p>
        </div>
      );

    case "timeline":
      return (
        <div className="infographic-section">
          <div className="infographic-section-icon">{INFOGRAPHIC_ICONS[block.icon]}</div>
          <div className="infographic-section-body">
            <h4>{block.heading}</h4>
            <div className="infographic-timeline-track">
              {block.steps.map((step, i) => (
                <div className="infographic-timeline-step" key={i}>
                  <div className="infographic-timeline-dot" />
                  <b>{step.label}</b>
                </div>
              ))}
            </div>
            <p className="infographic-timeline-caption">{block.caption}</p>
          </div>
        </div>
      );

    case "table":
      return (
        <div className="infographic-section">
          <div className="infographic-section-icon">{TABLE_ICON}</div>
          <div className="infographic-section-body infographic-table-wrap">
            <h4>{block.heading}</h4>
            <table>
              <caption>{block.heading}</caption>
              <thead>
                <tr>
                  {block.columns.map((col, i) => (
                    <th key={i} scope="col">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );

    case "compare":
      return (
        <div className="infographic-section">
          <div className="infographic-section-icon">{COMPARE_ICON}</div>
          <div className="infographic-section-body">
            <h4>{block.heading}</h4>
            <div className="infographic-compare-body">
              {[block.left, block.right].map((col, i) => (
                <div className="infographic-compare-col" key={i}>
                  <h5>{col.label}</h5>
                  <ul aria-label={col.label}>
                    {col.points.map((point, j) => (
                      <li key={j}>{point}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>
      );

    case "steps":
      return (
        <div className="infographic-section">
          <div className="infographic-section-icon">{STEPS_ICON}</div>
          <div className="infographic-section-body">
            <h4>{block.heading}</h4>
            <ol className="infographic-steps-list">
              {block.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ol>
          </div>
        </div>
      );

    default:
      return null;
  }
}
