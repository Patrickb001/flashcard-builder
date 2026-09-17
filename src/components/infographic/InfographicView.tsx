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
 * The absence of `allow-scripts` is the point: no script the model wrote — a
 * <script> tag, an inline handler, anything inside an SVG — can execute, in
 * this frame or anywhere else. The two flags that ARE set grant the frame
 * nothing it could act on, precisely because nothing inside it runs:
 *
 *  - `allow-same-origin` lets *this* component (running unsandboxed, in the
 *    app's own document) reach into the frame's DOM to read its height and to
 *    mirror the app's current theme onto it.
 *  - `allow-modals` lets the parent's own saveAsPdf call print() on the frame.
 *    Modals are script APIs, so with no scripts the document cannot open one
 *    itself.
 *
 * Both are safe only while `allow-scripts` stays absent; adding it would turn
 * each of them into a real capability. Never dangerouslySetInnerHTML.
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

    // Measure the BODY, never documentElement: documentElement.scrollHeight is
    // floored at the viewport height, and the viewport here is the height we
    // ourselves set — so it can only ever grow. The largest of these three is
    // used because none alone is sufficient: the bounding box shrinks
    // correctly but misses out-of-flow overflow (absolutely positioned or
    // transformed children), while scrollHeight/offsetHeight pick that
    // overflow up. The frame's wrapper clips at overflow:hidden, so
    // under-measuring silently truncates the page.
    const measure = (doc: Document) => {
      const body = doc.body;
      if (!body) return doc.documentElement.scrollHeight;
      const style = doc.defaultView?.getComputedStyle(body);
      const margins = style
        ? parseFloat(style.marginTop || '0') + parseFloat(style.marginBottom || '0')
        : 0;
      return Math.ceil(
        Math.max(
          body.getBoundingClientRect().height + margins,
          body.scrollHeight,
          body.offsetHeight
        )
      );
    };

    const syncFrame = () => {
      // A second `load` (the sandbox permits the frame to navigate itself)
      // would otherwise leave the previous observer pair still running,
      // orphaned once this function replaces them below.
      resizeObserver?.disconnect();
      themeObserver?.disconnect();

      const doc = iframe.contentDocument;
      const root = doc?.documentElement;
      if (!doc || !root) return;

      applyTheme();
      iframe.style.height = `${measure(doc)}px`;

      // Fonts loading async, or the content reflowing at a new width, can
      // change the document's height after this first measurement — this
      // keeps the iframe's own height in step with it for as long as it's
      // mounted, rather than only once on load.
      resizeObserver = new ResizeObserver(() => {
        iframe.style.height = `${measure(doc)}px`;
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
    // The frame can finish loading before this passive effect attaches the
    // listener; without this the sync would never run at all.
    if (iframe.contentDocument?.readyState === "complete") syncFrame();
    return () => {
      iframe.removeEventListener("load", syncFrame);
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
    };
  }, [infographic.html]);

  /**
   * Hands the frame's own document to the browser's print dialog, where "Save
   * as PDF" is a destination.
   *
   * Printing the frame rather than this page is deliberate: the browser then
   * treats the infographic as the print root and paginates it natively, where
   * a print stylesheet on the parent would leave a tall iframe clipped at one
   * page in some browsers.
   *
   * The theme is forced to light for the duration. The frame otherwise prints
   * in whatever theme the app is showing, and dark mode means a full-bleed
   * black page. `afterprint` puts the reader's own theme back; if a browser
   * never fires it the frame simply stays light until it next re-renders,
   * which is cosmetic rather than broken.
   */
  const saveAsPdf = () => {
    const frame = iframeRef.current;
    const frameWindow = frame?.contentWindow;
    const root = frame?.contentDocument?.documentElement;
    if (!frameWindow || !root) return;

    const previousTheme = root.getAttribute("data-theme");
    root.setAttribute("data-theme", "light");
    frameWindow.addEventListener(
      "afterprint",
      () => {
        if (previousTheme) root.setAttribute("data-theme", previousTheme);
        else root.removeAttribute("data-theme");
      },
      { once: true }
    );

    frameWindow.print();
  };

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
          // allow-modals is here ONLY so the parent's own saveAsPdf can call
          // print() on this frame — sandboxed frames block modal dialogs
          // otherwise. It grants the document itself nothing: print, alert and
          // confirm are all script APIs, and without allow-scripts no script
          // in here runs at all, so nothing in the model's HTML can reach a
          // modal. allow-scripts must never be added alongside it.
          sandbox="allow-same-origin allow-modals"
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
        <button type="button" className="ghost-btn" onClick={saveAsPdf}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v12M8 11l4 4 4-4M4 19h16" />
          </svg>
          Save as PDF
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
