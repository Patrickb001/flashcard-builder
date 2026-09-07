import * as pdfjsLib from 'pdfjs-dist';
// Vite-friendly worker import: bundles the worker as its own asset.
import PdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker';
import type { DocumentSection, OcrPage, PositionedItem } from './documentModel';
import { analyzePage } from './layoutAnalysis';
import { stripRepeatedFurniture } from './sectioning';

let workerStarted = false;

/**
 * Starts the PDF worker, once, on first use.
 *
 * This ran at module scope, so merely importing this file spawned a 1.3MB
 * worker - including for visitors who only ever paste a URL. Deferring it
 * means the worker is created when a PDF is actually opened and never
 * otherwise.
 */
function ensureWorker(): void {
  if (workerStarted) return;
  pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();
  workerStarted = true;
}

/** How much of the page to render for OCR. A starting point — see
 *  docs/tuning-notes.md once this has been exercised against real documents. */
const PDF_RENDER_SCALE = 1.5;
const PDF_RENDER_JPEG_QUALITY = 0.82;
/** Pages actually rendered and sent for OCR, per upload. Pages beyond this are
 *  simply omitted from the result — see "Non-goals" in
 *  docs/superpowers/specs/2026-09-07-pdf-ocr-support-design.md. */
const MAX_OCR_PAGES = 24;
/** Hard cap on a rendered page's longer edge, in pixels — independent of
 *  PDF_RENDER_SCALE. A PDF whose declared page size is abnormally large
 *  (e.g. a scanned/photographed PDF whose MediaBox is set to the source
 *  photo's raw pixel dimensions rather than a real physical page size)
 *  would otherwise render at many megapixels and produce a JPEG too large
 *  for MAX_IMAGE_BASE64_CHARS in generateHandler.ts. A normal PDF (Letter,
 *  A4, etc.) never comes close to this cap, so its render is unaffected. */
const MAX_RENDER_DIMENSION = 1600;

/** Renders one PDF page to a JPEG, base64-encoded with no `data:` prefix. */
async function renderPageToJpeg(page: pdfjsLib.PDFPageProxy): Promise<string> {
  const natural = page.getViewport({ scale: 1 });
  const longerEdge = Math.max(natural.width, natural.height);
  const scale = Math.min(PDF_RENDER_SCALE, MAX_RENDER_DIMENSION / longerEdge);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get a 2D canvas context to render this page.');
  await page.render({ canvasContext: ctx, viewport }).promise;

  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Rendering this page to an image failed.'))),
      'image/jpeg',
      PDF_RENDER_JPEG_QUALITY
    );
  });

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read the rendered page image.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Reads a PDF into structured sections, plus any pages pdf.js found no text
 * on — scanned or photographed pages.
 *
 * Text items are handed to the layout analyser exactly in the order pdf.js
 * emits them. That order follows the document's own reading order, shape by
 * shape, and preserving it is what keeps side-by-side columns from being
 * interleaved. Sorting the items by position would destroy that information.
 *
 * A zero-text page is always reported in `ocrPages` (so a caller can say
 * "N pages look scanned" even without OCR available), but is only actually
 * rendered to an image — the caller's real cost, both in time and in what it
 * can send to the model — when `ocrEnabled` is true, up to `MAX_OCR_PAGES`.
 */
export async function extractPdfSections(
  file: File,
  options: { ocrEnabled: boolean } = { ocrEnabled: false }
): Promise<{ sections: DocumentSection[]; ocrPages: OcrPage[] }> {
  ensureWorker();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  const sections: DocumentSection[] = [];
  const ocrPages: OcrPage[] = [];
  let rendered = 0;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    const items: PositionedItem[] = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      if (!item.str || !item.str.trim()) continue;
      items.push({
        str: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width ?? 0,
        // The transform's scale components give the rendered size, which is
        // more reliable than the declared font size for detecting headings.
        fontSize: Math.hypot(item.transform[2], item.transform[3]) || 12,
      });
    }

    if (items.length > 0) {
      const section = analyzePage(items, `Page ${pageNum}`);
      section.pageNum = pageNum;
      sections.push(section);
    } else {
      const label = `Page ${pageNum}`;
      if (options.ocrEnabled && rendered < MAX_OCR_PAGES) {
        const image = await renderPageToJpeg(page);
        ocrPages.push({ pageNum, label, image });
        rendered += 1;
      } else if (!options.ocrEnabled) {
        ocrPages.push({ pageNum, label });
      }
    }

    page.cleanup();
  }

  return { sections: stripRepeatedFurniture(sections), ocrPages };
}
