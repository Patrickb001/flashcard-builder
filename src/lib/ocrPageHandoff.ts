import type { OcrPage } from './documentModel';

/**
 * A same-tab, in-memory handoff for the images extractPdfSections rendered.
 *
 * OcrPage.image data does not travel through React Router's location.state —
 * the browser History API caps how much can be pushed through pushState (as
 * low as ~640KB in some browsers), and a handful of rendered page JPEGs for a
 * 16+ page scan can exceed that. This is the alternative: a plain module-level
 * variable, read and written within the same running SPA instance, never
 * serialized. See "Getting the images from Upload to Review without the
 * History API" in docs/superpowers/specs/2026-09-07-pdf-ocr-support-design.md.
 *
 * Like React Router's own location.state, this does not survive a reload —
 * consistent with src/routes/reviewDraft.ts's existing "a draft is never
 * recoverable once the tab is refreshed" limitation.
 */
let pending: OcrPage[] = [];

/**
 * Called by the uploader before every parse attempt — PDF or not — so a stale
 * scan from a cancelled or earlier upload never leaks into an unrelated deck.
 */
export function stashOcrPages(pages: OcrPage[]): void {
  pending = pages;
}

/** Read, non-destructively, by the review screen on mount. */
export function readOcrPages(): OcrPage[] {
  return pending;
}
