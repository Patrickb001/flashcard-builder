import { useEffect, useRef, useState } from "react";
import type { Infographic } from "../../types";
import { deleteInfographicModalCopy } from "../../lib/infographicCopy";
import { currentTheme } from "../../lib/theme";
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
 * One saved infographic: the model's own self-contained HTML/SVG document,
 * shown through a sandboxed iframe rather than through this app's own DOM.
 *
 * `sandbox="allow-same-origin"` with no `allow-scripts` is the point: no
 * script the model wrote — a <script> tag, an inline handler, anything
 * inside an SVG — can execute, in this frame or anywhere else. `allow-same-
 * origin` alone is what lets *this* component (running unsandboxed, in the
 * app's own document) still reach into the frame's DOM below to read its
 * height and to mirror the app's current theme onto it; it grants the frame
 * no privilege it could act on, since nothing inside it can run at all.
 * Never dangerouslySetInnerHTML.
 */
export default function InfographicView({ infographic, totalCardCount, onBack, onDelete }: Props) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const copy = deleteInfographicModalCopy(infographic.title);
  const usedAllCards = infographic.cardIds.length === totalCardCount;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    let resizeObserver: ResizeObserver | null = null;
    let themeObserver: MutationObserver | null = null;

    const applyTheme = () => {
      iframe.contentDocument?.documentElement.setAttribute("data-theme", currentTheme());
    };

    const syncFrame = () => {
      const root = iframe.contentDocument?.documentElement;
      if (!root) return;

      applyTheme();
      iframe.style.height = `${root.scrollHeight}px`;

      // Fonts loading async, or the content reflowing at a new width, can
      // change the document's height after this first measurement — this
      // keeps the iframe's own height in step with it for as long as it's
      // mounted, rather than only once on load.
      resizeObserver = new ResizeObserver(() => {
        iframe.style.height = `${root.scrollHeight}px`;
      });
      resizeObserver.observe(root);

      // The app's theme toggle (ThemeToggle.tsx) sets data-theme on the
      // main document with no event of its own to listen for — this is
      // what keeps an already-open infographic in step with it, rather
      // than only picking up the app's theme once, at load.
      themeObserver = new MutationObserver(applyTheme);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    };

    iframe.addEventListener("load", syncFrame);
    return () => {
      iframe.removeEventListener("load", syncFrame);
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
    };
  }, [infographic.html]);

  return (
    <div>
      <p className="deck-eyebrow infographic-view-meta">
        {DETAIL_LABEL[infographic.detail]} ·{" "}
        {usedAllCards ? `all ${totalCardCount} cards` : `${infographic.cardIds.length} cards`}
      </p>

      <div className="infographic-frame-wrap">
        <iframe
          ref={iframeRef}
          className="infographic-frame"
          title={infographic.title}
          srcDoc={infographic.html}
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
        />
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
