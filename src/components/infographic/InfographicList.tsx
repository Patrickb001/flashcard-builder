import type { Infographic } from "../../types";

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
  const handleDelete = (infographic: Infographic) => {
    if (confirm(`Delete "${infographic.title}"? This can't be undone.`)) {
      onDelete(infographic.id);
    }
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
            <button type="button" className="btn-delete" onClick={() => handleDelete(infographic)}>
              Delete
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="new-infographic-card" onClick={onCreate}>
        + Create infographic
      </button>
    </div>
  );
}
