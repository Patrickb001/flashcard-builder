import * as pdfjsLib from 'pdfjs-dist';
// Vite-friendly worker import: bundles the worker as its own asset.
import PdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker';
import type { DocumentSection, PositionedItem } from './documentModel';
import { analyzePage, stripRepeatedFurniture } from './layoutAnalysis';

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

/**
 * Reads a PDF into structured sections.
 *
 * Text items are handed to the layout analyser exactly in the order pdf.js
 * emits them. That order follows the document's own reading order, shape by
 * shape, and preserving it is what keeps side-by-side columns from being
 * interleaved. Sorting the items by position would destroy that information.
 */
export async function extractPdfSections(file: File): Promise<DocumentSection[]> {
  ensureWorker();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  const sections: DocumentSection[] = [];

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
      sections.push(analyzePage(items, `Page ${pageNum}`));
    }

    page.cleanup();
  }

  return stripRepeatedFurniture(sections);
}
