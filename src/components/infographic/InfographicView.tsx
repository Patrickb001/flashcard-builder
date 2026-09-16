import { useState } from "react";
import type { Infographic } from "../../types";
import InfographicBlockCard from "./blocks";
import { deleteInfographicModalCopy } from "../../lib/infographicCopy";
import Modal from "../ui/Modal";

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
 * One saved infographic in full: title, then every block in its own card.
 *
 * The dashed page-break divider every 3 blocks is presentational only —
 * see the spec's "Pagination is presentation, not data" note. Nothing about
 * where a block actually falls on a page is stored; this is purely a
 * visual cue that content of this length would run to more than one page.
 */
export default function InfographicView({ infographic, totalCardCount, onBack, onDelete }: Props) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const copy = deleteInfographicModalCopy(infographic.title);
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
          {infographic.blocks.map((block, index) => (
            <div key={index}>
              {index > 0 && index % 3 === 0 && (
                <div className="page-break">Page {Math.floor(index / 3) + 1}</div>
              )}
              <InfographicBlockCard block={block} />
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
        <button type="button" className="ghost-btn" onClick={() => setConfirmingDelete(true)} style={{ color: "var(--danger)" }}>
          Delete this infographic
        </button>
      </div>

      <Modal open={confirmingDelete} onClose={() => setConfirmingDelete(false)} labelledBy="delete-infographic-title" danger>
        <div className="dialog-head">
          <div className="dialog-title-row">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 7c4.5 8 8 8 8.5 8s3-6 7.5-8" />
            </svg>
            <h2 id="delete-infographic-title">{copy.title}</h2>
          </div>
          <button type="button" className="icon-btn" title="Cancel" aria-label="Cancel" onClick={() => setConfirmingDelete(false)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <p className="body-text">{copy.body}</p>
        <div className="dialog-actions">
          <button type="button" className="ghost-btn" onClick={() => setConfirmingDelete(false)}>
            Cancel
          </button>
          <button type="button" className="btn-danger-solid" onClick={onDelete}>
            Delete infographic
          </button>
        </div>
      </Modal>
    </div>
  );
}
