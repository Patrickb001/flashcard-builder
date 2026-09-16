import { useState } from "react";
import type { Infographic } from "../../types";
import { deleteInfographicModalCopy } from "../../lib/infographicCopy";
import Modal from "../ui/Modal";

interface Props {
  infographics: Infographic[];
  onView: (infographic: Infographic) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
}

const DETAIL_LABEL: Record<Infographic["detail"], string> = {
  basic: "Basic",
  standard: "Standard",
  detailed: "Detailed",
};

/** Every infographic saved for a deck, plus a tile to start another one. */
export default function InfographicList({ infographics, onView, onDelete, onCreate }: Props) {
  const [deleting, setDeleting] = useState<Infographic | null>(null);
  const copy = deleting ? deleteInfographicModalCopy(deleting.title) : null;

  const confirmDelete = () => {
    if (deleting) onDelete(deleting.id);
    setDeleting(null);
  };

  return (
    <div className="infographic-grid">
      {infographics.map((infographic) => (
        <div key={infographic.id} className="infographic-card">
          <div className="infographic-card-top">
            <span className="detail-tag">{DETAIL_LABEL[infographic.detail]}</span>
          </div>
          <h4>{infographic.title}</h4>
          <p className="meta">
            {infographic.blocks.length} section{infographic.blocks.length === 1 ? "" : "s"} ·{" "}
            {infographic.cardIds.length} card{infographic.cardIds.length === 1 ? "" : "s"} ·{" "}
            {new Date(infographic.createdAt).toLocaleDateString()}
          </p>
          <div className="infographic-card-actions">
            <button type="button" className="btn-view" onClick={() => onView(infographic)}>
              View
            </button>
            <button type="button" className="btn-delete" onClick={() => setDeleting(infographic)}>
              Delete
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="new-infographic-card" onClick={onCreate}>
        + Create infographic
      </button>

      <Modal open={!!deleting} onClose={() => setDeleting(null)} labelledBy="delete-infographic-title" danger>
        <div className="dialog-head">
          <div className="dialog-title-row">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 7c4.5 8 8 8 8.5 8s3-6 7.5-8" />
            </svg>
            <h2 id="delete-infographic-title">{copy?.title}</h2>
          </div>
          <button type="button" className="icon-btn" title="Cancel" aria-label="Cancel" onClick={() => setDeleting(null)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <p className="body-text">{copy?.body}</p>
        <div className="dialog-actions">
          <button type="button" className="ghost-btn" onClick={() => setDeleting(null)}>
            Cancel
          </button>
          <button type="button" className="btn-danger-solid" onClick={confirmDelete}>
            Delete infographic
          </button>
        </div>
      </Modal>
    </div>
  );
}
