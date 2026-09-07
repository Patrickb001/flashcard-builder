# PDF OCR Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a PDF page has no extractable text (a scanned or photographed page), transcribe it with Claude's vision instead of silently dropping it or failing the whole upload, so decks like `docs/pdf-test/EXAM 1 STUDY GUIDE.pdf` (16 pages, every page a full-page scan, zero embedded text) can be turned into flashcards.

**Architecture:** A new OCR pipeline (`ocrPrompt.ts` transcription prompt + `ocrGenerator.ts` batch/retry driver, mirroring the existing card-drafting pipeline's shape) sits in front of the existing card-drafting pipeline. `pdfParser.ts` renders zero-text pages to JPEGs instead of dropping them; a new multimodal path in `aiTransport.ts`/`generateHandler.ts` sends those images to Claude; `CandidateReview.tsx` transcribes them into ordinary `DocumentSection`s before handing everything to the untouched `generateCandidatesWithAi`. Rendered images travel from `Uploader.tsx` to `CandidateReview.tsx` through a small in-memory handoff module rather than React Router state, to avoid the browser History API's state-size limits.

**Tech Stack:** TypeScript, React, Vite, `pdfjs-dist` (already a dependency), Anthropic API (`claude-sonnet-5`) via the app's existing hosted/BYOK transport, Node (`--experimental-strip-types`) for test tooling.

**Spec:** `docs/superpowers/specs/2026-09-07-pdf-ocr-support-design.md`

**Task order note:** Tasks are sequenced so `npx tsc -b` is green after every single task's commit — not just at the end of the plan. This is why `pdfParser.ts`'s rendering change and `Uploader.tsx`'s wiring (its only call site) are one task (Task 3) rather than two: splitting them would leave the project's only call site of a changed function signature broken across a commit boundary. The in-memory handoff module (Task 2) comes before that because `Uploader.tsx`'s rewritten code calls it directly.

## Global Constraints

- `MAX_TOKENS.ocr` must be identical between `src/lib/aiTransport.ts` and `src/server/generateHandler.ts` — the pre-existing constraint for every other task, extended to this one. Set to `16000` in both.
- `AiTask` gains `'ocr'` in `src/lib/aiTransport.ts` only — `src/server/generateHandler.ts`'s task lookup is a `Map<string, string>` keyed by plain strings, not the `AiTask` union, so it needs its own `'ocr'` entry but no type change.
- `callModel`'s new `images` parameter is always the **fifth**, optional argument, after the existing `signal`. Every existing call site (`aiGenerator.ts`, `quizGenerator.ts`) calls `callModel` with four or fewer arguments today and must not be touched by this plan.
- `images`, when sent to `/api/generate`, is a plain array of bare base64 JPEG strings (no `data:` prefix) under the key `images`, sibling to the existing `sections` key. `JSON.stringify` drops an `undefined` `images` field, so every task other than `'ocr'` sends byte-for-byte the same request body as before this plan.
- `OcrPage.image`'s presence is the one thing every piece of this plan agrees on: **set** means the page was rendered and is ready to send to the model; **absent** means it was only detected (`ocrEnabled` was `false` when `extractPdfSections` ran, or a page was beyond `MAX_OCR_PAGES`). Nothing in this plan ever tries to OCR a page whose `OcrPage` has no `image`.
- No new runtime (`dependencies`) package. `pdfjs-dist` (already present) does the page rendering, using the browser's own `<canvas>` — nothing new to install.
- Every task that calls the real Anthropic API costs real money and only runs when `ANTHROPIC_API_KEY` is set (shell env or a `.env` file), read the same way every existing `tools/test-*.mjs` script already reads it. If no key is available when a task is executed, run the step, let it print "Skipped — set ANTHROPIC_API_KEY to run it.", and say so plainly rather than inventing a result.
- `src/lib/pdfParser.ts` cannot be imported or run under plain Node — it imports `pdfjs-dist/build/pdf.worker.mjs?worker`, a Vite-only import suffix, and its new rendering step needs a real browser `<canvas>`. This is a pre-existing constraint (see `tools/test-layout.mjs`, which re-implements pdf.js text extraction directly rather than importing `pdfParser.ts`) — this plan does not change it, and pdfParser.ts's rendering path is verified manually in the browser, not by a `tools/test-*.mjs` script.

---

### Task 1: Data model — `OcrPage` and `DocumentSection.pageNum`

**Files:**
- Modify: `src/lib/documentModel.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `OcrPage` (exported interface: `{ pageNum: number; label: string; image?: string }`) and `DocumentSection.pageNum?: number` — both consumed by every later task in this plan.

- [ ] **Step 1: Add the `OcrPage` interface**

In `src/lib/documentModel.ts`, find this exact block:

```ts
/** Raw positioned text as handed over by pdf.js (or synthesized from pptx). */
export interface PositionedItem {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
}
```

Replace it with:

```ts
/** Raw positioned text as handed over by pdf.js (or synthesized from pptx). */
export interface PositionedItem {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

/**
 * One PDF page pdf.js found no text on — a scanned or photographed page.
 *
 * Always produced for a zero-text page, so a caller can report that scanned
 * pages exist even without reading them. `image` (a bare base64 JPEG, no
 * `data:` prefix) is populated only when the caller asked for OCR rendering —
 * see extractPdfSections in pdfParser.ts.
 */
export interface OcrPage {
  pageNum: number;
  /** "Page N" — matches the label a text-bearing page from the same document carries. */
  label: string;
  image?: string;
}
```

- [ ] **Step 2: Add `pageNum` to `DocumentSection`**

Find this exact block:

```ts
export interface DocumentSection {
  /** "Page 3", "Slide 3" or "Section 3" — shown on the card as its source. */
  label: string;
  /** The page/slide title, if one was detected. */
  title?: string;
  /**
   * Which document this section came from, when a deck is built from several
   * at once. Drafting batches never mix groups, so every card in a batch can be
   * attributed to the right source.
   */
  group?: string;
  blocks: Block[];
}
```

Replace it with:

```ts
export interface DocumentSection {
  /** "Page 3", "Slide 3" or "Section 3" — shown on the card as its source. */
  label: string;
  /** The page/slide title, if one was detected. */
  title?: string;
  /**
   * Which document this section came from, when a deck is built from several
   * at once. Drafting batches never mix groups, so every card in a batch can be
   * attributed to the right source.
   */
  group?: string;
  /**
   * Which page this section came from — set only by the PDF pipeline (both
   * pdf.js's direct text extraction and OCR transcription), so the two can be
   * merged back into page order in CandidateReview. Every other format's
   * parser leaves this undefined.
   */
  pageNum?: number;
  blocks: Block[];
}
```

- [ ] **Step 3: Confirm the file still compiles**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/lib/documentModel.ts
git commit -m "Add OcrPage and DocumentSection.pageNum for PDF OCR support"
```

---

### Task 2: Upload-to-Review image handoff

**Files:**
- Create: `src/lib/ocrPageHandoff.ts`

**Interfaces:**
- Consumes: `OcrPage` from `./documentModel` (Task 1).
- Produces: `stashOcrPages(pages: OcrPage[]): void` and `readOcrPages(): OcrPage[]`, consumed by Task 3 (`Uploader.tsx`, writer) and Task 7 (`ReviewRoute.tsx`, reader).

- [ ] **Step 1: Write `src/lib/ocrPageHandoff.ts`**

```ts
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
```

- [ ] **Step 2: Confirm the file compiles**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Smoke-test it**

Run:

```bash
node --experimental-strip-types --import ./tools/register.mjs -e "
import { stashOcrPages, readOcrPages } from './src/lib/ocrPageHandoff.ts';
const pages = [{ pageNum: 1, label: 'Page 1', image: 'abc' }];
stashOcrPages(pages);
if (readOcrPages() !== pages) throw new Error('readOcrPages did not return the stashed array');
if (readOcrPages().length !== 1) throw new Error('wrong length');
stashOcrPages([]);
if (readOcrPages().length !== 0) throw new Error('stash did not clear');
console.log('ok — stash/read round-trips and clears');
"
```

Expected: prints `ok — stash/read round-trips and clears`, exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ocrPageHandoff.ts
git commit -m "Add the in-memory OCR page handoff between Uploader and Review"
```

---

### Task 3: Render zero-text PDF pages, and wire the result into `Uploader.tsx`

**Files:**
- Modify: `src/lib/pdfParser.ts`
- Modify: `src/components/Uploader.tsx`

**Interfaces:**
- Consumes: `OcrPage` from `./documentModel` (Task 1); `stashOcrPages` from `../lib/ocrPageHandoff` (Task 2).
- Produces: `extractPdfSections(file: File, options?: { ocrEnabled: boolean }): Promise<{ sections: DocumentSection[]; ocrPages: OcrPage[] }>` — a breaking change to this function's return shape (was `Promise<DocumentSection[]>`). `Uploader.tsx` is this function's only call site in the app, so both files change together in this one task — splitting them would leave that call site broken across a commit boundary. No change to `Uploader`'s own `Props.onParsed` signature.

- [ ] **Step 1: Rewrite `extractPdfSections` and add the rendering helper**

In `src/lib/pdfParser.ts`, find the entire file content:

```ts
import * as pdfjsLib from 'pdfjs-dist';
// Vite-friendly worker import: bundles the worker as its own asset.
import PdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker';
import type { DocumentSection, PositionedItem } from './documentModel';
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
```

Replace the whole file with:

```ts
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

/** Renders one PDF page to a JPEG, base64-encoded with no `data:` prefix. */
async function renderPageToJpeg(page: pdfjsLib.PDFPageProxy): Promise<string> {
  const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
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
```

- [ ] **Step 2: Confirm this file compiles on its own**

Run: `npx tsc -b`
Expected: **fails**, specifically in `src/components/Uploader.tsx` — its call site still expects `extractPdfSections` to return a plain `DocumentSection[]`. This is expected; continue to Step 3. If `tsc` reports an error anywhere other than `Uploader.tsx`, stop and re-check Step 1 against the exact blocks above before continuing.

- [ ] **Step 3: Import the handoff module in `Uploader.tsx`**

In `src/components/Uploader.tsx`, find:

```ts
import { useCallback, useMemo, useRef, useState } from 'react';
import AiSettingsPanel from './AiSettingsPanel';
import type { AiSettings } from '../lib/aiGenerator';
import { loadAiSettings } from '../lib/aiGenerator';
import type { SourceType } from '../types';
import type { DocumentSection } from '../lib/documentModel';
```

Replace it with:

```ts
import { useCallback, useMemo, useRef, useState } from 'react';
import AiSettingsPanel from './AiSettingsPanel';
import type { AiSettings } from '../lib/aiGenerator';
import { loadAiSettings } from '../lib/aiGenerator';
import type { SourceType } from '../types';
import type { DocumentSection } from '../lib/documentModel';
import { stashOcrPages } from '../lib/ocrPageHandoff';
```

- [ ] **Step 4: Rewrite `handleFile`**

Find:

```ts
  /** Picks a parser from the file's extension and runs it, lazily imported. */
  const handleFile = useCallback(
    async (file: File) => {
      const lowerName = file.name.toLowerCase();
      const isPdf = lowerName.endsWith('.pdf') || file.type === 'application/pdf';
      const isPptx =
        lowerName.endsWith('.pptx') ||
        file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      // Text formats are matched on extension alone: browsers report .md and
      // saved pages as text/plain, text/markdown or nothing, by platform.
      const isMarkdown = /\.(md|markdown|mdown|mkd)$/.test(lowerName);
      const isHtml = /\.(html?|xhtml)$/.test(lowerName);

      if (!isPdf && !isPptx && !isMarkdown && !isHtml) {
        setError('Please choose a .pdf, .pptx, .md or .html file.');
        setStatus('error');
        return;
      }

      setStatus('parsing');
      setError(null);
      try {
        // Each parser is fetched only when a file of that type is chosen.
        // Imported statically, all four rode in the entry chunk, so every
        // visitor downloaded pdf.js and JSZip before seeing the deck list.
        let sections;
        if (isPdf) {
          sections = await (await import('../lib/pdfParser')).extractPdfSections(file);
        } else if (isPptx) {
          sections = await (await import('../lib/pptxParser')).extractPptxSections(file);
        } else if (isMarkdown) {
          sections = await (await import('../lib/markdownParser')).extractMarkdownSections(file);
        } else {
          sections = await (await import('../lib/htmlParser')).extractHtmlSections(file);
        }
        if (sections.length === 0) {
          setError(
            isPdf
              ? "Couldn't find any text in that file. If it's a scanned/image-only PDF, this app can't read it yet."
              : 'That file looks empty — there was no text to turn into cards.'
          );
          setStatus('error');
          return;
        }
        const sourceType: SourceType = isPdf ? 'pdf' : isPptx ? 'pptx' : isMarkdown ? 'md' : 'html';
        onParsed(sections, file.name, sourceType, ai);
      } catch (err) {
        console.error(err);
        setError('Something went wrong while reading that file. Please try another one.');
        setStatus('error');
      }
    },
    [onParsed, ai]
  );
```

Replace it with:

```ts
  /** Picks a parser from the file's extension and runs it, lazily imported. */
  const handleFile = useCallback(
    async (file: File) => {
      const lowerName = file.name.toLowerCase();
      const isPdf = lowerName.endsWith('.pdf') || file.type === 'application/pdf';
      const isPptx =
        lowerName.endsWith('.pptx') ||
        file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      // Text formats are matched on extension alone: browsers report .md and
      // saved pages as text/plain, text/markdown or nothing, by platform.
      const isMarkdown = /\.(md|markdown|mdown|mkd)$/.test(lowerName);
      const isHtml = /\.(html?|xhtml)$/.test(lowerName);

      if (!isPdf && !isPptx && !isMarkdown && !isHtml) {
        setError('Please choose a .pdf, .pptx, .md or .html file.');
        setStatus('error');
        return;
      }

      setStatus('parsing');
      setError(null);
      // Cleared before every attempt, PDF or not, so a scan stashed for a
      // cancelled or earlier upload never leaks into an unrelated deck.
      stashOcrPages([]);
      try {
        if (isPdf) {
          const { sections, ocrPages } = await (
            await import('../lib/pdfParser')
          ).extractPdfSections(file, { ocrEnabled: ai.mode !== 'off' });

          if (sections.length === 0 && ocrPages.length === 0) {
            setError("Couldn't find any text in that file. If it's a scanned/image-only PDF, this app can't read it yet.");
            setStatus('error');
            return;
          }
          if (sections.length === 0 && ai.mode === 'off') {
            // ocrPages.length > 0 here — every page looked scanned, but there
            // is nothing rendered for them (ocrEnabled was false).
            setError(
              "Couldn't find any text in that file. It looks like a scanned/photographed PDF — turn on AI drafting above and try again so the model can read it."
            );
            setStatus('error');
            return;
          }

          let notice: string | undefined;
          if (ai.mode === 'off' && ocrPages.length > 0) {
            // A mixed PDF (real text plus scanned pages) with AI off: the
            // deck still builds from the text pages, but the gap is worth a
            // notice on the review screen rather than being silent.
            notice = `${ocrPages.length} page${ocrPages.length === 1 ? '' : 's'} look like scanned images and have no readable text — turn on AI drafting above to read them.`;
          }

          // Stashed even when empty, so ReviewRoute reads a real (possibly
          // empty) list rather than something left over from a previous file.
          stashOcrPages(ocrPages);
          onParsed(sections, file.name, 'pdf', ai, notice);
          return;
        }

        // Each parser is fetched only when a file of that type is chosen.
        // Imported statically, all four rode in the entry chunk, so every
        // visitor downloaded pdf.js and JSZip before seeing the deck list.
        let sections;
        if (isPptx) {
          sections = await (await import('../lib/pptxParser')).extractPptxSections(file);
        } else if (isMarkdown) {
          sections = await (await import('../lib/markdownParser')).extractMarkdownSections(file);
        } else {
          sections = await (await import('../lib/htmlParser')).extractHtmlSections(file);
        }
        if (sections.length === 0) {
          setError('That file looks empty — there was no text to turn into cards.');
          setStatus('error');
          return;
        }
        const sourceType: SourceType = isPptx ? 'pptx' : isMarkdown ? 'md' : 'html';
        onParsed(sections, file.name, sourceType, ai);
      } catch (err) {
        console.error(err);
        setError('Something went wrong while reading that file. Please try another one.');
        setStatus('error');
      }
    },
    [onParsed, ai]
  );
```

- [ ] **Step 5: Confirm both files now compile together**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 6: Manual check — a normal (non-scanned) PDF still works**

`extractPdfSections` cannot be run from Node (see Global Constraints), so this is checked in the browser.

Run: `npm run dev`, open the app, choose "New deck from a file", and upload any normal, text-based PDF you have on hand (not `docs/pdf-test/EXAM 1 STUDY GUIDE.pdf` — that one has no real text and needs Task 7 to be useful). Expected: parses and reaches the review screen exactly as before this task.

- [ ] **Step 7: Manual check — the two scanned-PDF paths**

Still in the running dev server:

1. With AI drafting off (the default), upload `docs/pdf-test/EXAM 1 STUDY GUIDE.pdf`. Expected: the error message now reads "...it looks like a scanned/photographed PDF — turn on AI drafting above and try again so the model can read it."
2. Turn AI drafting on (hosted or BYOK). Upload the same file again. Expected: no error — it proceeds to the review screen. (What the review screen actually *does* with the scanned pages is wired up in Task 7; at this point in the plan, expect an empty candidate list with no OCR activity yet — that is correct for where the plan is at this point.)

- [ ] **Step 8: Commit**

```bash
git add src/lib/pdfParser.ts src/components/Uploader.tsx
git commit -m "Render zero-text PDF pages to JPEGs for OCR, and wire it into Uploader"
```

---

### Task 4: OCR transcription prompt and response parser

**Files:**
- Create: `src/lib/ocrPrompt.ts`
- Create: `tools/test-ocr.mjs`

**Interfaces:**
- Consumes: `Block`, `DocumentSection`, `OcrPage`, `applyContext` from `./documentModel` (the last two from Task 1); `parseJsonArray` from `./textUtils` (pre-existing).
- Produces: `OCR_SYSTEM_PROMPT` (string) and `parseOcrResponse(text: string, pages: OcrPage[]): DocumentSection[]`, both consumed by Task 5 (`aiTransport.ts`'s `PROMPTS` map, `generateHandler.ts`'s `PROMPTS` map) and Task 6 (`ocrGenerator.ts`).

- [ ] **Step 1: Write `src/lib/ocrPrompt.ts`**

```ts
import type { Block, DocumentSection, OcrPage } from './documentModel';
import { applyContext } from './documentModel';
import { parseJsonArray } from './textUtils';

/**
 * Transcribes scanned/photographed PDF pages, the same way cardPrompt.ts's
 * CARD_SYSTEM_PROMPT turns blocks into cards: one prompt, shared between the
 * hosted server route and the bring-your-own-key browser route (both go
 * through src/lib/aiTransport.ts).
 *
 * Deliberately asks for less structure than the full Block union — no table,
 * code or image detection from a photograph, only heading/paragraph/list. See
 * "Non-goals" in docs/superpowers/specs/2026-09-07-pdf-ocr-support-design.md.
 */
export const OCR_SYSTEM_PROMPT = `You are given one or more scanned or photographed pages from a study document, each labeled with the page it came from. Transcribe the readable text of each page faithfully.

Rules:
1. Preserve headings, paragraphs, and bullet lists as separate blocks. Do not summarize or paraphrase — transcribe what is written.
2. Never invent text you cannot read. Skip illegible words, illegible lines, or illegible pages entirely rather than guessing at their content.
3. Ignore page furniture: page numbers, headers/footers, watermarks, scan artifacts.
4. Work through the pages in the order given, one entry per page.

Return ONLY a JSON array, no markdown fence, no commentary. Each element:
{"page": string, "title": string | null, "blocks": [{"type": "heading", "text": string} | {"type": "paragraph", "heading": string | null, "text": string} | {"type": "list", "heading": string | null, "items": string[]}]}

"page" is the page's label, copied exactly from what you were given. A page with nothing legible on it still gets an entry, with an empty "blocks" array.`;

/**
 * Parses a model response into sections, matched back to the real OcrPage by
 * the "page" label it echoed — the same defensive lookup-by-label pattern
 * cardPrompt.ts's parseCardsResponse uses for a card's "source".
 *
 * Tolerates a fenced or truncated reply via parseJsonArray. A page the model
 * never returned an entry for (dropped by truncation, or a "page" value that
 * matches nothing) is simply left out of the result — the caller
 * (ocrGenerator.ts) is what turns "never got a section" into a reported
 * failure, since there is no rule-based fallback for a page with no text.
 */
export function parseOcrResponse(text: string, pages: OcrPage[]): DocumentSection[] {
  const byLabel = new Map(pages.map((p) => [p.label, p]));
  const sections: DocumentSection[] = [];

  for (const raw of parseJsonArray(text)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.page !== 'string') continue;
    const page = byLabel.get(entry.page);
    if (!page) continue;

    const title = typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : undefined;
    const rawBlocks = Array.isArray(entry.blocks) ? entry.blocks : [];
    const blocks: Block[] = [];

    for (const rb of rawBlocks) {
      if (!rb || typeof rb !== 'object') continue;
      const b = rb as Record<string, unknown>;
      const heading = typeof b.heading === 'string' && b.heading.trim() ? b.heading.trim() : undefined;

      if (b.type === 'heading' && typeof b.text === 'string' && b.text.trim()) {
        blocks.push({ kind: 'heading', text: b.text.trim(), level: 2 });
      } else if (b.type === 'paragraph' && typeof b.text === 'string' && b.text.trim()) {
        blocks.push({ kind: 'paragraph', text: b.text.trim(), heading });
      } else if (b.type === 'list' && Array.isArray(b.items)) {
        const items = b.items.filter(
          (i: unknown): i is string => typeof i === 'string' && i.trim().length > 0
        );
        if (items.length > 0) blocks.push({ kind: 'list', items, heading });
      }
    }

    if (title) blocks.unshift({ kind: 'heading', text: title, level: 1 });
    applyContext(blocks, title);

    sections.push({ label: page.label, title, pageNum: page.pageNum, blocks });
  }

  return sections;
}
```

- [ ] **Step 2: Confirm the file compiles**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Write `tools/test-ocr.mjs` with its structural parsing checks**

This tool grows in later tasks (Task 5 adds a real transport smoke test, Task 6 adds a full round-trip test). This step only writes its first part, which needs no API key at all.

Create `tools/test-ocr.mjs`:

```javascript
import { parseOcrResponse } from '../src/lib/ocrPrompt.ts';

/**
 * Exercises the OCR transcription pipeline (src/lib/ocrPrompt.ts,
 * src/lib/aiTransport.ts, src/lib/ocrGenerator.ts) at increasing depth:
 *
 *   node --experimental-strip-types --import ./tools/register.mjs \
 *     tools/test-ocr.mjs
 *
 * The later parts call the real model, cost real money, and only run when
 * ANTHROPIC_API_KEY is set (shell env or a .env file), same as every other
 * tools/test-*.mjs script.
 */

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`);
};

// ---------------------------------------------------------------------------
// Part 1 — parseOcrResponse: pure, no API key needed.
// ---------------------------------------------------------------------------

console.log('Part 1 — parseOcrResponse\n');

const pages = [
  { pageNum: 1, label: 'Page 1' },
  { pageNum: 2, label: 'Page 2' },
  { pageNum: 3, label: 'Page 3' }, // deliberately not mentioned in the response below
];

const responseText = JSON.stringify([
  {
    page: 'Page 1',
    title: 'Preload',
    blocks: [
      {
        type: 'paragraph',
        heading: null,
        text: 'Preload is the volume of blood filling the ventricle at the end of diastole.',
      },
      { type: 'list', heading: 'Key terms', items: ['End-diastolic volume', 'Frank-Starling mechanism'] },
    ],
  },
  { page: 'Page 2', title: null, blocks: [] },
  { page: 'Page 99', title: 'Unmatched', blocks: [{ type: 'paragraph', heading: null, text: 'Ignored.' }] },
]);

const parsed = parseOcrResponse(responseText, pages);

check('two real pages produced sections', parsed.length === 2, `got ${parsed.length}`);
check(
  'Page 1 carries its pageNum, a title heading, a paragraph, and a list',
  parsed[0]?.pageNum === 1 && parsed[0]?.blocks.length === 3,
  JSON.stringify(parsed[0])
);
check(
  'Page 2 (nothing legible) still produced a section, with just its title-less empty blocks',
  parsed[1]?.pageNum === 2 && parsed[1]?.blocks.length === 0,
  JSON.stringify(parsed[1])
);
check(
  'Page 3 (never in the response) and "Page 99" (not a real page) produced nothing',
  !parsed.some((s) => s.label === 'Page 3' || s.label === 'Unmatched'),
  parsed.map((s) => s.label).join(', ')
);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} CHECK(S) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 4: Run it**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-ocr.mjs`
Expected: `All checks passed.`, exit 0. No API key needed for this part.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ocrPrompt.ts tools/test-ocr.mjs
git commit -m "Add the OCR transcription prompt and response parser"
```

---

### Task 5: Multimodal transport — `aiTransport.ts` and `generateHandler.ts`

**Files:**
- Modify: `src/lib/aiTransport.ts`
- Modify: `src/server/generateHandler.ts`
- Modify: `tools/test-ocr.mjs`

**Interfaces:**
- Consumes: `OCR_SYSTEM_PROMPT` from `./ocrPrompt` (Task 4).
- Produces: `callModel(task, payload, settings, signal?, images?: string[])` — the fifth parameter, consumed by Task 6 (`ocrGenerator.ts`). `handleGenerate` accepting an optional `images: string[]` field in its request body.

- [ ] **Step 1: Add the `ocr` task to `aiTransport.ts`**

In `src/lib/aiTransport.ts`, find:

```ts
import type { AiSettings } from './aiGenerator';
import { CARD_SYSTEM_PROMPT } from './cardPrompt';
import { QUIZ_SYSTEM_PROMPT, VIGNETTE_SYSTEM_PROMPT, VIGNETTE_AUDIT_SYSTEM_PROMPT } from './quizPrompt';
```

Replace it with:

```ts
import type { AiSettings } from './aiGenerator';
import { CARD_SYSTEM_PROMPT } from './cardPrompt';
import { QUIZ_SYSTEM_PROMPT, VIGNETTE_SYSTEM_PROMPT, VIGNETTE_AUDIT_SYSTEM_PROMPT } from './quizPrompt';
import { OCR_SYSTEM_PROMPT } from './ocrPrompt';
```

Find:

```ts
export type AiTask = 'cards' | 'quiz' | 'vignette' | 'vignette-audit';

/** The prompts, for the direct-from-browser route which has no server to ask. */
const PROMPTS: Record<AiTask, string> = {
  cards: CARD_SYSTEM_PROMPT,
  quiz: QUIZ_SYSTEM_PROMPT,
  vignette: VIGNETTE_SYSTEM_PROMPT,
  'vignette-audit': VIGNETTE_AUDIT_SYSTEM_PROMPT,
};
```

Replace it with:

```ts
export type AiTask = 'cards' | 'quiz' | 'vignette' | 'vignette-audit' | 'ocr';

/** The prompts, for the direct-from-browser route which has no server to ask. */
const PROMPTS: Record<AiTask, string> = {
  cards: CARD_SYSTEM_PROMPT,
  quiz: QUIZ_SYSTEM_PROMPT,
  vignette: VIGNETTE_SYSTEM_PROMPT,
  'vignette-audit': VIGNETTE_AUDIT_SYSTEM_PROMPT,
  ocr: OCR_SYSTEM_PROMPT,
};
```

Find:

```ts
const MAX_TOKENS: Record<AiTask, number> = {
  cards: 16000,
  quiz: 8000,
  vignette: 16000,
  // A verdict list, not prose — see "vignette-audit" in docs/tuning-notes.md
  // once real batches have been measured against this starting estimate.
  'vignette-audit': 1000,
};
```

Replace it with:

```ts
const MAX_TOKENS: Record<AiTask, number> = {
  cards: 16000,
  quiz: 8000,
  vignette: 16000,
  // A verdict list, not prose — see "vignette-audit" in docs/tuning-notes.md
  // once real batches have been measured against this starting estimate.
  'vignette-audit': 1000,
  // A transcribed page can be as dense as a card-drafting batch; same
  // ceiling as `cards` until real batches say otherwise (docs/tuning-notes.md).
  ocr: 16000,
};
```

- [ ] **Step 2: Thread `images` through `callHosted`**

Find:

```ts
async function callHosted(task: AiTask, payload: unknown, signal?: AbortSignal): Promise<ModelReply> {
  const guard = withTimeout(signal);
  let res: Response;
  try {
    res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The field is still called "sections" though it now sometimes carries
      // cards. It means "the JSON for the model"; renaming it would break the
      // deployed function for no gain.
      body: JSON.stringify({ task, sections: payload }),
      signal: guard.signal,
    });
  } catch (err) {
    rethrowAsTimeout(err, guard);
  } finally {
    guard.done();
  }
```

Replace it with:

```ts
async function callHosted(
  task: AiTask,
  payload: unknown,
  signal?: AbortSignal,
  images?: string[]
): Promise<ModelReply> {
  const guard = withTimeout(signal);
  let res: Response;
  try {
    res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The field is still called "sections" though it now sometimes carries
      // cards, or an OCR page-label manifest. It means "the JSON for the
      // model"; renaming it would break the deployed function for no gain.
      // `images` is omitted from the JSON entirely when undefined, so every
      // task other than "ocr" sends exactly the request it always has.
      body: JSON.stringify({ task, sections: payload, images }),
      signal: guard.signal,
    });
  } catch (err) {
    rethrowAsTimeout(err, guard);
  } finally {
    guard.done();
  }
```

- [ ] **Step 3: Thread `images` through `callDirect`**

Find:

```ts
async function callDirect(
  task: AiTask,
  payload: unknown,
  apiKey: string,
  signal?: AbortSignal
): Promise<ModelReply> {
  const guard = withTimeout(signal);
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Required for browser-originated calls.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS[task],
        // Sent as a cacheable block rather than a bare string. The prompt is
        // byte-identical on every request of a run and sits ahead of the batch
        // payload, so after the first request the rest of the run reads it from
        // cache. Drafting a document is many requests behind one long prompt,
        // which is exactly the shape caching pays for.
        system: [
          { type: 'text', text: PROMPTS[task], cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: JSON.stringify(payload) }],
      }),
      signal: guard.signal,
    });
  } catch (err) {
    rethrowAsTimeout(err, guard);
  } finally {
    guard.done();
  }
```

Replace it with:

```ts
async function callDirect(
  task: AiTask,
  payload: unknown,
  apiKey: string,
  signal?: AbortSignal,
  images?: string[]
): Promise<ModelReply> {
  const guard = withTimeout(signal);
  // Multimodal only when there are images to send — every other task keeps
  // today's bare-string content, byte-for-byte.
  const content =
    images && images.length > 0
      ? [
          ...images.map((data) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data },
          })),
          { type: 'text' as const, text: JSON.stringify(payload) },
        ]
      : JSON.stringify(payload);
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Required for browser-originated calls.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS[task],
        // Sent as a cacheable block rather than a bare string. The prompt is
        // byte-identical on every request of a run and sits ahead of the batch
        // payload, so after the first request the rest of the run reads it from
        // cache. Drafting a document is many requests behind one long prompt,
        // which is exactly the shape caching pays for.
        system: [
          { type: 'text', text: PROMPTS[task], cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content }],
      }),
      signal: guard.signal,
    });
  } catch (err) {
    rethrowAsTimeout(err, guard);
  } finally {
    guard.done();
  }
```

- [ ] **Step 4: Thread `images` through the exported `callModel`**

Find:

```ts
export function callModel(
  task: AiTask,
  payload: unknown,
  settings: AiSettings,
  signal?: AbortSignal
): Promise<ModelReply> {
  return settings.mode === 'byok' && settings.apiKey
    ? callDirect(task, payload, settings.apiKey, signal)
    : callHosted(task, payload, signal);
}
```

Replace it with:

```ts
export function callModel(
  task: AiTask,
  payload: unknown,
  settings: AiSettings,
  signal?: AbortSignal,
  images?: string[]
): Promise<ModelReply> {
  return settings.mode === 'byok' && settings.apiKey
    ? callDirect(task, payload, settings.apiKey, signal, images)
    : callHosted(task, payload, signal, images);
}
```

- [ ] **Step 5: Confirm `aiTransport.ts` compiles on its own**

Run: `npx tsc -b`
Expected: exits 0. `src/lib/aiTransport.ts` is self-contained (the new `AiTask` member, `PROMPTS`/`MAX_TOKENS` entries, and `images` parameter are all added together in Steps 1-4, and `images` is optional so every existing call site stays valid) — this should already be green before touching `generateHandler.ts`. If it isn't, re-check Steps 1-4 against the exact blocks above before continuing.

- [ ] **Step 6: Add the `ocr` task to `generateHandler.ts` and accept `images`**

In `src/server/generateHandler.ts`, find:

```ts
import { CARD_SYSTEM_PROMPT } from '../lib/cardPrompt';
import { QUIZ_SYSTEM_PROMPT, VIGNETTE_SYSTEM_PROMPT, VIGNETTE_AUDIT_SYSTEM_PROMPT } from '../lib/quizPrompt';
import type { HandlerResult } from './endpoint';
```

Replace it with:

```ts
import { CARD_SYSTEM_PROMPT } from '../lib/cardPrompt';
import { QUIZ_SYSTEM_PROMPT, VIGNETTE_SYSTEM_PROMPT, VIGNETTE_AUDIT_SYSTEM_PROMPT } from '../lib/quizPrompt';
import { OCR_SYSTEM_PROMPT } from '../lib/ocrPrompt';
import type { HandlerResult } from './endpoint';
```

Find:

```ts
const MAX_TOKENS: Record<string, number> = {
  cards: 16000,
  quiz: 8000,
  vignette: 16000,
  'vignette-audit': 1000,
};
```

Replace it with:

```ts
const MAX_TOKENS: Record<string, number> = {
  cards: 16000,
  quiz: 8000,
  vignette: 16000,
  'vignette-audit': 1000,
  ocr: 16000,
};
```

Find:

```ts
const PROMPTS = new Map<string, string>([
  ['cards', CARD_SYSTEM_PROMPT],
  ['quiz', QUIZ_SYSTEM_PROMPT],
  ['vignette', VIGNETTE_SYSTEM_PROMPT],
  ['vignette-audit', VIGNETTE_AUDIT_SYSTEM_PROMPT],
]);

/** Anything larger than this is refused before it reaches the model. */
const MAX_REQUEST_CHARS = 120_000;
```

Replace it with:

```ts
const PROMPTS = new Map<string, string>([
  ['cards', CARD_SYSTEM_PROMPT],
  ['quiz', QUIZ_SYSTEM_PROMPT],
  ['vignette', VIGNETTE_SYSTEM_PROMPT],
  ['vignette-audit', VIGNETTE_AUDIT_SYSTEM_PROMPT],
  ['ocr', OCR_SYSTEM_PROMPT],
]);

/** Anything larger than this is refused before it reaches the model. */
const MAX_REQUEST_CHARS = 120_000;

/**
 * Guardrails for the OCR task's images, independent of MAX_REQUEST_CHARS
 * above (which only ever measured text). Sized to stay comfortably under
 * Netlify's ~6MB synchronous function payload limit even at the cap.
 */
const MAX_OCR_IMAGES = 4;
const MAX_IMAGE_BASE64_CHARS = 2_000_000;
```

- [ ] **Step 7: Build the multimodal upstream request when `images` is present**

Find:

```ts
  const { sections, task } = (body ?? {}) as { sections?: unknown; task?: unknown };

  if (!Array.isArray(sections) || sections.length === 0) {
    return { status: 400, body: { error: 'Expected a non-empty "sections" array.' } };
  }

  // An older client sends no task at all, so the default keeps it working.
  const taskName = typeof task === 'string' && task ? task : 'cards';
  const systemPrompt = PROMPTS.get(taskName);
  if (!systemPrompt) {
    return { status: 400, body: { error: 'Unknown task.' } };
  }

  const payload = JSON.stringify(sections);
  if (payload.length > MAX_REQUEST_CHARS) {
    return { status: 413, body: { error: 'Payload too large.' } };
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': options.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: options.model || DEFAULT_MODEL,
        max_tokens: MAX_TOKENS[taskName] ?? MAX_TOKENS.cards,
        // Sent as a cacheable block rather than a bare string. The prompt is
        // byte-identical on every request of a run and sits ahead of the batch
        // payload, so after the first request the rest of the run reads it from
        // cache. Drafting a document is many requests behind one long prompt,
        // which is exactly the shape caching pays for.
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: payload }],
      }),
    });
```

Replace it with:

```ts
  const { sections, task, images } = (body ?? {}) as {
    sections?: unknown;
    task?: unknown;
    images?: unknown;
  };

  if (!Array.isArray(sections) || sections.length === 0) {
    return { status: 400, body: { error: 'Expected a non-empty "sections" array.' } };
  }

  // An older client sends no task at all, so the default keeps it working.
  const taskName = typeof task === 'string' && task ? task : 'cards';
  const systemPrompt = PROMPTS.get(taskName);
  if (!systemPrompt) {
    return { status: 400, body: { error: 'Unknown task.' } };
  }

  const payload = JSON.stringify(sections);
  if (payload.length > MAX_REQUEST_CHARS) {
    return { status: 413, body: { error: 'Payload too large.' } };
  }

  let imageList: string[] | undefined;
  if (images !== undefined) {
    const valid =
      Array.isArray(images) &&
      images.length > 0 &&
      images.length <= MAX_OCR_IMAGES &&
      images.every(
        (img) => typeof img === 'string' && img.length > 0 && img.length <= MAX_IMAGE_BASE64_CHARS
      );
    if (!valid) {
      return { status: 413, body: { error: 'Invalid or oversized "images".' } };
    }
    imageList = images as string[];
  }

  // Multimodal only when images passed validation above — every other task's
  // request body is unchanged.
  const content = imageList
    ? [
        ...imageList.map((data) => ({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data },
        })),
        { type: 'text', text: payload },
      ]
    : payload;

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': options.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: options.model || DEFAULT_MODEL,
        max_tokens: MAX_TOKENS[taskName] ?? MAX_TOKENS.cards,
        // Sent as a cacheable block rather than a bare string. The prompt is
        // byte-identical on every request of a run and sits ahead of the batch
        // payload, so after the first request the rest of the run reads it from
        // cache. Drafting a document is many requests behind one long prompt,
        // which is exactly the shape caching pays for.
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content }],
      }),
    });
```

- [ ] **Step 8: Confirm both files compile**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 9: Add a real transport smoke test to `tools/test-ocr.mjs`**

This needs a valid (if content-free) image to send — there is no PDF-rendered fixture available to a Node script (see the Global Constraints note on `pdfParser.ts`), so this builds one by hand: a minimal solid-color PNG, using only Node's built-in `zlib` and a standard CRC32 (no image library, no new dependency).

At the top of `tools/test-ocr.mjs`, find:

```javascript
import { parseOcrResponse } from '../src/lib/ocrPrompt.ts';
```

Replace it with:

```javascript
import fs from 'node:fs';
import zlib from 'node:zlib';
import { parseOcrResponse } from '../src/lib/ocrPrompt.ts';

function readKeyFromEnvFile() {
  try {
    return fs.readFileSync('.env', 'utf8').match(/ANTHROPIC_API_KEY=(.+)/)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

const key = process.env.ANTHROPIC_API_KEY ?? readKeyFromEnvFile();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * A minimal valid solid-gray PNG, built by hand, base64-encoded. Standing in
 * for a rendered page image in these tests — real transcription quality is
 * verified manually against docs/pdf-test/EXAM 1 STUDY GUIDE.pdf, per the
 * design spec's Verification section. This is structurally real enough for
 * Anthropic's API to accept as an image, which is what Part 2 and Part 3
 * below actually need: proof the multimodal request round-trips.
 */
function makeTestPng(size = 32) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor (RGB)
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // One filter-type byte (0 = none) plus 3 bytes/pixel, per row.
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const idatData = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idatData),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}
```

At the end of `tools/test-ocr.mjs`, find:

```javascript
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} CHECK(S) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
```

Replace it with:

```javascript
// ---------------------------------------------------------------------------
// Part 2 — transport smoke test: does a multimodal OCR request round-trip?
// ---------------------------------------------------------------------------

console.log('\nPart 2 — multimodal transport\n');

if (!key) {
  console.log('  Skipped — set ANTHROPIC_API_KEY to run it.');
} else {
  const { callModel } = await import('../src/lib/aiTransport.ts');
  const png = makeTestPng();
  const { text } = await callModel('ocr', [{ page: 'Page 1' }], { mode: 'byok', apiKey: key }, undefined, [
    png,
  ]);
  console.log(`  Reply: ${text.slice(0, 300)}`);
  check('transport: got a non-empty reply for a multimodal OCR request', text.trim().length > 0);
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} CHECK(S) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 10: Run it**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-ocr.mjs`

If `ANTHROPIC_API_KEY` is set, expected: Part 1 and Part 2 both pass, `All checks passed.`, and the printed reply is a JSON array mentioning "Page 1" (the image has no real text, so an empty or near-empty transcription is correct — this step is checking the request/response round-trips, not transcription quality). If no key is set, expected: Part 2 prints `Skipped — set ANTHROPIC_API_KEY to run it.` and the script still exits 0 (Part 1's checks still ran and passed).

- [ ] **Step 11: Commit**

```bash
git add src/lib/aiTransport.ts src/server/generateHandler.ts tools/test-ocr.mjs
git commit -m "Add a multimodal request path for the new ocr AI task"
```

---

### Task 6: OCR batch/retry driver — `ocrGenerator.ts`

**Files:**
- Create: `src/lib/ocrGenerator.ts`
- Modify: `tools/test-ocr.mjs`

**Interfaces:**
- Consumes: `DocumentSection`, `OcrPage` from `./documentModel` (Task 1); `AiSettings` from `./aiGenerator` (pre-existing); `callModel` from `./aiTransport` (Task 5); `runBatches`, `BatchProgress` from `./batchRunner` (pre-existing); `parseOcrResponse` from `./ocrPrompt` (Task 4).
- Produces: `transcribePagesWithAi(pages: OcrPage[], settings: AiSettings, options?: OcrGenerationOptions): Promise<OcrResult>` and the `OcrResult`/`OcrGenerationOptions` types, consumed by Task 7 (`CandidateReview.tsx`).

- [ ] **Step 1: Write `src/lib/ocrGenerator.ts`**

```ts
import type { DocumentSection, OcrPage } from './documentModel';
import type { AiSettings } from './aiGenerator';
import { callModel } from './aiTransport';
import { runBatches, type BatchProgress } from './batchRunner';
import { parseOcrResponse } from './ocrPrompt';

/**
 * Transcribes scanned pages into real DocumentSections, batch by batch.
 *
 * Mirrors generateCandidatesWithAi's two-pass batch/retry structure (see
 * src/lib/aiGenerator.ts) — an initial pass, then one retry pass at a smaller
 * batch size for anything a truncated reply left uncovered — adapted to
 * produce sections instead of cards. There is no rule-based fallback step
 * here: unlike a section with real text, a page with no text at all has
 * nothing to fall back to if the model never covers it.
 */

/** Pages per OCR request, on the first pass. */
const OCR_BATCH_SIZE = 3;
/** Pages per request on the retry pass — the same "give whatever failed the
 *  most headroom" reasoning aiGenerator.ts's RETRY_BATCH_SIZE uses. */
const OCR_RETRY_BATCH_SIZE = 1;

export interface OcrGenerationOptions {
  /** Fired after every batch, for the progress banner. */
  onProgress?: (progress: BatchProgress) => void;
  signal?: AbortSignal;
}

export interface OcrResult {
  sections: DocumentSection[];
  /** Labels of pages no batch ever produced a transcription for. */
  failedPages: string[];
  failedBatches: number;
  totalBatches: number;
  truncatedBatches: number;
  firstError: string | null;
  /** True when the user stopped the run. Not a failure, and not reported as one. */
  aborted: boolean;
}

function chunk(pages: OcrPage[], size: number): OcrPage[][] {
  const batches: OcrPage[][] = [];
  for (let i = 0; i < pages.length; i += size) batches.push(pages.slice(i, i + size));
  return batches;
}

export async function transcribePagesWithAi(
  pages: OcrPage[],
  settings: AiSettings,
  options: OcrGenerationOptions = {}
): Promise<OcrResult> {
  const sections: DocumentSection[] = [];
  // Every label a section has ever been produced for, across every batch and
  // both passes — what decides whether a page still missing at the end is
  // genuinely failed.
  const coveredLabels = new Set<string>();

  let failedBatches = 0;
  let truncatedBatches = 0;
  let totalBatches = 0;
  let done = 0;
  let firstError: string | null = null;
  let aborted = false;

  /**
   * Runs one batch and returns the pages it left uncovered.
   *
   * Throwing is reserved for a batch that produced nothing at all. A batch
   * that transcribed some of its pages is a partial success, and the ones a
   * truncated reply left out come back here to be retried.
   */
  async function runBatch(batch: OcrPage[]): Promise<OcrPage[]> {
    const images = batch.map((p) => p.image).filter((img): img is string => !!img);
    const manifest = batch.map((p) => ({ page: p.label }));
    const { text, stopReason } = await callModel('ocr', manifest, settings, options.signal, images);
    const truncated = stopReason === 'max_tokens';
    if (truncated) truncatedBatches += 1;

    const parsed = parseOcrResponse(text, batch);
    if (parsed.length === 0) {
      throw new Error(
        truncated
          ? 'The reply was cut off by the length limit before any page was transcribed.'
          : 'No pages transcribed'
      );
    }

    const coveredInBatch = new Set<string>();
    for (const section of parsed) {
      sections.push(section);
      coveredLabels.add(section.label);
      coveredInBatch.add(section.label);
    }

    return truncated ? batch.filter((p) => !coveredInBatch.has(p.label)) : [];
  }

  /** Runs one pass over a list of batches, collecting the pages it did not cover. */
  async function runPass(batches: OcrPage[][]): Promise<OcrPage[]> {
    const missed: OcrPage[] = [];

    const outcome = await runBatches(batches, async (batch) => {
      missed.push(...(await runBatch(batch)));
    }, {
      signal: options.signal,
      onProgress: options.onProgress,
      progressOffset: { done, total: totalBatches },
      onFailure: (batch, err) => {
        console.error('OCR batch failed:', err);
        missed.push(...batch);
      },
    });

    done += batches.length - outcome.remaining.length;
    totalBatches += batches.length;
    failedBatches += outcome.failedBatches;
    if (!firstError) firstError = outcome.firstError;
    if (outcome.aborted) aborted = true;

    for (const batch of outcome.remaining) missed.push(...batch);

    return missed;
  }

  let missing = await runPass(chunk(pages, OCR_BATCH_SIZE));

  // One bounded retry, one page at a time — the same shape aiGenerator.ts
  // gives a section a second, easier chance at.
  if (missing.length > 0 && !aborted) {
    missing = await runPass(chunk(missing, OCR_RETRY_BATCH_SIZE));
  }

  const failedPages: string[] = [];
  if (!aborted) {
    for (const page of missing) {
      if (coveredLabels.has(page.label)) continue;
      failedPages.push(page.label);
    }
  }

  return {
    sections,
    failedPages,
    failedBatches,
    totalBatches,
    truncatedBatches,
    firstError: aborted ? null : firstError,
    aborted,
  };
}
```

- [ ] **Step 2: Confirm the file compiles**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Add the full round-trip test to `tools/test-ocr.mjs`**

At the end of `tools/test-ocr.mjs`, find:

```javascript
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} CHECK(S) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
```

Replace it with:

```javascript
// ---------------------------------------------------------------------------
// Part 3 — full transcribePagesWithAi round trip.
// ---------------------------------------------------------------------------

console.log('\nPart 3 — transcribePagesWithAi\n');

if (!key) {
  console.log('  Skipped — set ANTHROPIC_API_KEY to run it.');
} else {
  const { transcribePagesWithAi } = await import('../src/lib/ocrGenerator.ts');
  const png = makeTestPng();
  const ocrPages = [
    { pageNum: 1, label: 'Page 1', image: png },
    { pageNum: 2, label: 'Page 2', image: png },
  ];

  const result = await transcribePagesWithAi(ocrPages, { mode: 'byok', apiKey: key });

  console.log(
    `  ${result.sections.length} section(s), ${result.totalBatches} batch(es), ${result.failedPages.length} failed page(s)`
  );
  for (const section of result.sections) {
    console.log(`    ${section.label} (page ${section.pageNum}): ${section.blocks.length} block(s)`);
  }
  if (result.firstError) console.log(`  !! ${result.firstError}`);

  check('ocr: every page produced a section', result.sections.length === ocrPages.length, `got ${result.sections.length}`);
  check('ocr: no failed pages', result.failedPages.length === 0, result.failedPages.join(', '));
  check(
    'ocr: pageNum carried through onto every section',
    result.sections.every((s) => typeof s.pageNum === 'number'),
    ''
  );
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} CHECK(S) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 4: Run it**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-ocr.mjs`
Expected (with a key set): all three parts pass, `All checks passed.`. The test image carries no real text, so empty or near-empty transcribed blocks are correct here — this is checking the batching/parsing plumbing, not transcription quality (verified manually in Task 7).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ocrGenerator.ts tools/test-ocr.mjs
git commit -m "Add transcribePagesWithAi, the OCR batch/retry driver"
```

---

### Task 7: Transcribe and merge scanned pages in `CandidateReview.tsx`

**Files:**
- Modify: `src/routes/ReviewRoute.tsx`
- Modify: `src/components/CandidateReview.tsx`

**Interfaces:**
- Consumes: `readOcrPages` from `../lib/ocrPageHandoff` (Task 2); `transcribePagesWithAi`, `OcrResult` from `../lib/ocrGenerator` (Task 6); `OcrPage` from `../lib/documentModel` (Task 1).
- Produces: `CandidateReview`'s `Props` gains `ocrPages?: OcrPage[]` — no other component in this plan consumes it further; this is the last hop.

- [ ] **Step 1: Pass the stashed pages from `ReviewRoute.tsx`**

In `src/routes/ReviewRoute.tsx`, find:

```ts
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import CandidateReview from '../components/CandidateReview';
import { draftFromState } from './reviewDraft';
```

Replace it with:

```ts
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import CandidateReview from '../components/CandidateReview';
import { draftFromState } from './reviewDraft';
import { readOcrPages } from '../lib/ocrPageHandoff';
```

Find:

```ts
    <CandidateReview
      sections={draft.sections}
      fileName={draft.fileName}
      sourceType={draft.sourceType}
      ai={draft.ai}
      notice={draft.notice}
      sourceUrls={draft.sourceUrls}
      // Replace, so Back from the new deck does not return to a review screen
      // whose cards have already been saved.
      onSaved={(deckId) => navigate(`/deck/${deckId}`, { replace: true })}
      onCancel={() => navigate('/')}
    />
```

Replace it with:

```ts
    <CandidateReview
      sections={draft.sections}
      fileName={draft.fileName}
      sourceType={draft.sourceType}
      ai={draft.ai}
      notice={draft.notice}
      sourceUrls={draft.sourceUrls}
      ocrPages={readOcrPages()}
      // Replace, so Back from the new deck does not return to a review screen
      // whose cards have already been saved.
      onSaved={(deckId) => navigate(`/deck/${deckId}`, { replace: true })}
      onCancel={() => navigate('/')}
    />
```

- [ ] **Step 2: Confirm this file alone**

Run: `npx tsc -b`
Expected: **fails** — `CandidateReview` does not accept an `ocrPages` prop yet. This is expected; continue to Step 3.

- [ ] **Step 3: Add imports and the `ocrPages` prop to `CandidateReview.tsx`**

In `src/components/CandidateReview.tsx`, find:

```tsx
import { useEffect, useState } from 'react';
import type { CandidateCard, Deck, Flashcard, SourceType } from '../types';
import type { DocumentSection } from '../lib/documentModel';
import { generateCandidates } from '../lib/flashcardGenerator';
import type { AiSettings } from '../lib/aiGenerator';
import type { BatchProgress } from '../lib/batchRunner';
import { generateCandidatesWithAi } from '../lib/aiGenerator';
import { saveDeckWithCards } from '../db/db';
import CardAttachments from './ui/CardAttachments';
import DraftingBanner from './ui/DraftingBanner';
import ProgressBar from './ui/ProgressBar';
```

Replace it with:

```tsx
import { useEffect, useState } from 'react';
import type { CandidateCard, Deck, Flashcard, SourceType } from '../types';
import type { DocumentSection, OcrPage } from '../lib/documentModel';
import { generateCandidates } from '../lib/flashcardGenerator';
import type { AiSettings } from '../lib/aiGenerator';
import type { BatchProgress } from '../lib/batchRunner';
import { generateCandidatesWithAi } from '../lib/aiGenerator';
import { transcribePagesWithAi } from '../lib/ocrGenerator';
import { saveDeckWithCards } from '../db/db';
import CardAttachments from './ui/CardAttachments';
import DraftingBanner from './ui/DraftingBanner';
import ProgressBar from './ui/ProgressBar';
```

Find:

```tsx
  /** The address(es) read, for a deck built from one or more URLs. */
  sourceUrls?: string[];
  /** Fired with the new deck's id once it is safely in the database. */
  onSaved: (deckId: string) => void;
  onCancel: () => void;
}
```

Replace it with:

```tsx
  /** The address(es) read, for a deck built from one or more URLs. */
  sourceUrls?: string[];
  /**
   * Scanned/photographed pages a PDF upload found no text on. Only entries
   * with `image` set (ocrEnabled was true when the file was parsed) are ever
   * transcribed; undefined or empty for every non-PDF source.
   */
  ocrPages?: OcrPage[];
  /** Fired with the new deck's id once it is safely in the database. */
  onSaved: (deckId: string) => void;
  onCancel: () => void;
}
```

Find:

```tsx
export default function CandidateReview({
  sections,
  fileName,
  sourceType,
  ai,
  notice,
  sourceUrls,
  onSaved,
  onCancel,
}: Props) {
```

Replace it with:

```tsx
export default function CandidateReview({
  sections,
  fileName,
  sourceType,
  ai,
  notice,
  sourceUrls,
  ocrPages,
  onSaved,
  onCancel,
}: Props) {
```

- [ ] **Step 4: Add OCR state**

Find:

```tsx
  const [drafting, setDrafting] = useState(ai.mode !== 'off');
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [aiFailed, setAiFailed] = useState(false);
```

Replace it with:

```tsx
  const [drafting, setDrafting] = useState(ai.mode !== 'off');
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [aiFailed, setAiFailed] = useState(false);
  // True only while scanned pages are being transcribed — a phase that runs
  // before card drafting, and reuses the same banner/progress components.
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<BatchProgress | null>(null);
  const [ocrNotice, setOcrNotice] = useState<string | null>(null);
```

- [ ] **Step 5: Rewrite the drafting effect**

Find this entire block (the `useEffect` and its dependency array):

```tsx
  useEffect(() => {
    if (ai.mode === 'off') return;
    let cancelled = false;
    // A real signal, so navigating away actually stops the run. A local flag
    // alone left every remaining request in flight, drafting a document nobody
    // was waiting for and billing for it.
    const controller = new AbortController();

    (async () => {
      try {
        const { cards, fallbackCards: fallback, failedSections, truncatedBatches, firstError, aborted } =
          await generateCandidatesWithAi(sections, ai, {
            onProgress: (batch) => !cancelled && setProgress(batch),
            signal: controller.signal,
          });
        if (cancelled || aborted) return;
        // Always applied, including when empty: an empty AI result must
        // clear the (already-empty) list, not silently keep whatever was
        // there before, now that nothing is pre-seeded to fall back on.
        setCandidates(withKeys(cards));
        setFallbackCards(fallback);

        const unit = UNIT_NOUN[sourceType];
        // Reported in the document's own units. This counted batches before,
        // so a 16-page PDF that lost three batches of four said "3 of 4" and
        // read as though three quarters of the file had been unreadable.
        const failed = failedSections.length;
        // Named, but not all of them: a deck where thirty pages fell back would
        // otherwise put thirty labels in a banner nobody can read.
        const named =
          failedSections.length > 6
            ? `${failedSections.slice(0, 6).join(', ')} and ${failedSections.length - 6} more`
            : failedSections.join(', ');
        // A reply cut off by the length limit is the tool's fault and says so,
        // rather than being reported as though the model had nothing to offer.
        const why = truncatedBatches > 0
          ? 'The model ran out of room mid-answer on a dense part of the document.'
          : '';

        if (failed === 0) {
          setAiNotice(null);
        } else if (failed === sections.length) {
          // Nothing here came from the model. This must be unmissable: the
          // cards look normal and the count alone will not reveal that the
          // selected feature never ran.
          setAiFailed(true);
          setAiNotice(
            `AI drafting did not run. ${why} ${firstError ?? ''}`.trim()
          );
        } else {
          setAiFailed(false);
          setAiNotice(
            `${failed} of ${sections.length} ${unit}${sections.length === 1 ? '' : 's'} fell back to rule-based drafting (${named}). ${why}`.trim()
          );
        }
      } catch (err) {
        if (!cancelled) {
          setAiFailed(true);
          // A hard failure means generateCandidatesWithAi never returned at
          // all, so there is no fallbackCards to read from it — computed
          // fresh here for every section, or the button below would have
          // nothing to offer and the user would be left with an empty list.
          setFallbackCards(
            generateCandidates(sections).map((card) => ({ ...card, origin: 'rule-based' as const }))
          );
          setAiNotice(
            `AI drafting failed. ${err instanceof Error ? err.message : ''}`.trim()
          );
        }
      } finally {
        if (!cancelled) setDrafting(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sections, ai, sourceType]);
```

Replace it with:

```tsx
  useEffect(() => {
    if (ai.mode === 'off') return;
    let cancelled = false;
    // A real signal, so navigating away actually stops the run. A local flag
    // alone left every remaining request in flight, drafting a document nobody
    // was waiting for and billing for it.
    const controller = new AbortController();

    (async () => {
      // Reassigned once OCR resolves (below); the emergency fallback in catch
      // reads whatever this holds, so it is declared outside the try block
      // rather than as a `const` inside it.
      let workingSections = sections;
      try {
        // Scanned pages, if any, are transcribed first. From card drafting's
        // point of view below, an OCR'd page becomes indistinguishable from
        // any other section — it can get real AI-drafted cards, and a
        // rule-based fallback too if its own card drafting specifically fails.
        const toOcr = (ocrPages ?? []).filter((p) => p.image);
        if (toOcr.length > 0) {
          setOcrRunning(true);
          const ocrResult = await transcribePagesWithAi(toOcr, ai, {
            onProgress: (batch) => !cancelled && setOcrProgress(batch),
            signal: controller.signal,
          });
          if (cancelled || ocrResult.aborted) return;
          setOcrRunning(false);
          workingSections = [...sections, ...ocrResult.sections].sort(
            (a, b) => (a.pageNum ?? 0) - (b.pageNum ?? 0)
          );
          if (ocrResult.failedPages.length > 0) {
            setOcrNotice(
              `${ocrResult.failedPages.length} of ${toOcr.length} scanned page${toOcr.length === 1 ? '' : 's'} could not be read.`
            );
          }
        }

        const { cards, fallbackCards: fallback, failedSections, truncatedBatches, firstError, aborted } =
          await generateCandidatesWithAi(workingSections, ai, {
            onProgress: (batch) => !cancelled && setProgress(batch),
            signal: controller.signal,
          });
        if (cancelled || aborted) return;
        // Always applied, including when empty: an empty AI result must
        // clear the (already-empty) list, not silently keep whatever was
        // there before, now that nothing is pre-seeded to fall back on.
        setCandidates(withKeys(cards));
        setFallbackCards(fallback);

        const unit = UNIT_NOUN[sourceType];
        // Reported in the document's own units. This counted batches before,
        // so a 16-page PDF that lost three batches of four said "3 of 4" and
        // read as though three quarters of the file had been unreadable.
        const failed = failedSections.length;
        // Named, but not all of them: a deck where thirty pages fell back would
        // otherwise put thirty labels in a banner nobody can read.
        const named =
          failedSections.length > 6
            ? `${failedSections.slice(0, 6).join(', ')} and ${failedSections.length - 6} more`
            : failedSections.join(', ');
        // A reply cut off by the length limit is the tool's fault and says so,
        // rather than being reported as though the model had nothing to offer.
        const why = truncatedBatches > 0
          ? 'The model ran out of room mid-answer on a dense part of the document.'
          : '';

        if (failed === 0) {
          setAiNotice(null);
        } else if (failed === workingSections.length) {
          // Nothing here came from the model. This must be unmissable: the
          // cards look normal and the count alone will not reveal that the
          // selected feature never ran.
          setAiFailed(true);
          setAiNotice(
            `AI drafting did not run. ${why} ${firstError ?? ''}`.trim()
          );
        } else {
          setAiFailed(false);
          setAiNotice(
            `${failed} of ${workingSections.length} ${unit}${workingSections.length === 1 ? '' : 's'} fell back to rule-based drafting (${named}). ${why}`.trim()
          );
        }
      } catch (err) {
        if (!cancelled) {
          setAiFailed(true);
          // A hard failure means generateCandidatesWithAi (or the OCR step
          // before it) never returned at all, so there is no fallbackCards to
          // read from it — computed fresh here for whatever sections were
          // known at the point of failure, or the button below would have
          // nothing to offer and the user would be left with an empty list.
          setFallbackCards(
            generateCandidates(workingSections).map((card) => ({ ...card, origin: 'rule-based' as const }))
          );
          setAiNotice(
            `AI drafting failed. ${err instanceof Error ? err.message : ''}`.trim()
          );
        }
      } finally {
        if (!cancelled) {
          setDrafting(false);
          setOcrRunning(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sections, ocrPages, ai, sourceType]);
```

- [ ] **Step 6: Show the OCR phase, and gate the card-drafting phase on it having finished**

Find:

```tsx
      {drafting && (
        <>
          <DraftingBanner activity="drafting cards" progress={progress} />
          <ProgressBar fraction={progress ? progress.done / progress.total : 0} />
        </>
      )}

      {notice && (
```

Replace it with:

```tsx
      {ocrRunning && (
        <>
          <DraftingBanner activity="reading scanned pages" progress={ocrProgress} />
          <ProgressBar fraction={ocrProgress ? ocrProgress.done / ocrProgress.total : 0} />
        </>
      )}

      {drafting && !ocrRunning && (
        <>
          <DraftingBanner activity="drafting cards" progress={progress} />
          <ProgressBar fraction={progress ? progress.done / progress.total : 0} />
        </>
      )}

      {ocrNotice && (
        <div className="ai-notice partial" role="status">
          <strong>Some scanned pages could not be read</strong>
          <span>{ocrNotice}</span>
        </div>
      )}

      {notice && (
```

- [ ] **Step 7: Adjust the "waiting for cards" and "found N pages" copy**

Find:

```tsx
      {drafting && candidates.length === 0 && fallbackCards.length === 0 && (
        <p className="muted">Waiting for the first cards…</p>
      )}
```

Replace it with:

```tsx
      {drafting && !ocrRunning && candidates.length === 0 && fallbackCards.length === 0 && (
        <p className="muted">Waiting for the first cards…</p>
      )}
```

Find:

```tsx
      <p className="muted">
        Found {sections.length} {UNIT_NOUN[sourceType]}
        {sections.length === 1 ? '' : 's'} and drafted {candidates.length} candidate card
        {candidates.length === 1 ? '' : 's'}. Uncheck anything you don't want, edit the wording, or add
        your own before saving.
      </p>
```

Replace it with:

```tsx
      <p className="muted">
        Found {sections.length + (ocrPages?.length ?? 0)} {UNIT_NOUN[sourceType]}
        {sections.length + (ocrPages?.length ?? 0) === 1 ? '' : 's'} and drafted {candidates.length} candidate card
        {candidates.length === 1 ? '' : 's'}. Uncheck anything you don't want, edit the wording, or add
        your own before saving.
      </p>
```

- [ ] **Step 8: Confirm both files compile**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 9: Full manual pass with the real test PDF**

Run: `npm run dev`, open the app, turn AI drafting on (hosted needs a running dev server with `ANTHROPIC_API_KEY` set — see `.env`; BYOK needs a key pasted into the AI settings panel). Upload `docs/pdf-test/EXAM 1 STUDY GUIDE.pdf`.

Expected:
1. The "reading scanned pages" banner and progress bar appear first.
2. Once that finishes, the "drafting cards" banner takes over.
3. The candidate list ends up with real drafted cards, not an empty deck.
4. The "Found N pages" count reflects all 16 pages, not zero.
5. If you scroll through the candidates, cards drawn from later pages appear after cards from earlier pages (page order preserved through the merge).

This is the primary end-to-end proof this feature works — read the actual transcribed content and drafted cards, not just that something appeared.

- [ ] **Step 10: Commit**

```bash
git add src/routes/ReviewRoute.tsx src/components/CandidateReview.tsx
git commit -m "Transcribe and merge scanned PDF pages into candidate review"
```

---

### Task 8: Full verification and `docs/tuning-notes.md`

**Files:**
- Modify: `docs/tuning-notes.md`

**Interfaces:**
- Consumes: the results of running this plan's tools and the manual passes from Tasks 3 and 7.
- Produces: nothing consumed by code — documentation only, read by future contributors per the file's own header.

- [ ] **Step 1: Full project verification**

```bash
npx tsc -b
npm run build
node --experimental-strip-types --import ./tools/register.mjs tools/test-ocr.mjs
```

Expected: `tsc -b` exits 0, `npm run build` succeeds, and `tools/test-ocr.mjs` prints `All checks passed.` (Part 2 and Part 3 report "Skipped" instead if no key is set — record whichever actually happened for Step 3 below.)

- [ ] **Step 2: Manual pass — a mixed PDF, AI on**

If you have (or can quickly build, e.g. by combining a text-based PDF export with a photographed page) a PDF with some real-text pages and some scanned pages, upload it with AI drafting on. Expected: text pages parse normally, scanned pages get transcribed, and the merged deck's cards appear in the right page order — no error, no crash. If no such fixture is available, record that this manual pass was skipped rather than asserting it passed.

- [ ] **Step 3: Add the `ocr` row to the ceilings table**

In `docs/tuning-notes.md`, find:

```
| Task | Ceiling |
|---|---|
| `cards` | 16000 |
| `quiz` | 8000 |
| `vignette` | 16000 |
| `vignette-audit` | 1000 |
```

Replace it with:

```
| Task | Ceiling |
|---|---|
| `cards` | 16000 |
| `quiz` | 8000 |
| `vignette` | 16000 |
| `vignette-audit` | 1000 |
| `ocr` | 16000 |
```

Immediately below the existing "**Vignette-audit — why 1000.**" paragraph in that same section, add:

```

**OCR — why 16000.** A transcribed scanned page can be as text-dense as a card-drafting batch — the same reasoning as `cards`' ceiling — so it starts at the same value rather than a fresh estimate. This was not measured against a real run when it shipped; see the 2026-09-07 entry below for whether `docs/pdf-test/EXAM 1 STUDY GUIDE.pdf`'s 16 pages ever approached it.
```

- [ ] **Step 4: Append a new entry for this plan's own results**

At the end of the file, add:

```

---

## 2026-09-07 — PDF OCR support

**Why this exists.** `docs/pdf-test/EXAM 1 STUDY GUIDE.pdf` — 16 pages, ~107MB, every page a full-page scan with zero embedded text — could not produce a single flashcard before this: `pdfParser.ts` either dropped a zero-text page silently (a mixed PDF) or failed the whole upload (a fully-scanned one). Scanned pages are now rendered to JPEGs and transcribed through Claude's vision (a new `ocr` AI task, reusing the existing hosted/BYOK transport), merged back into the normal `DocumentSection` pipeline, and drafted into cards exactly like any other page. See `docs/superpowers/specs/2026-09-07-pdf-ocr-support-design.md` for the full design.

**Verification.** `tsc -b` and `npm run build` [passed / — state what actually happened]. `tools/test-ocr.mjs`'s three parts (response parsing, multimodal transport, full batch/retry round trip) [all passed / — state what actually happened, including which parts were skipped for lack of a key]. The end-to-end manual pass against the real test PDF (Task 7, Step 9) [produced real drafted cards in the correct page order / — state what actually happened]. The mixed-PDF manual pass (Task 8, Step 2) [was run against \_\_\_ / was skipped — no mixed-PDF fixture available].

**Open, not yet done:** the `ocr` ceiling (16000, borrowed from `cards`) has not been measured against a real dense scanned page — if a future run's `stopReason` comes back `max_tokens` for the OCR task, that is the signal to raise it, the same way `cards`' own ceiling was raised after a real overrun (see "Cards — why not 4000" above). `PDF_RENDER_SCALE` (1.5) and `PDF_RENDER_JPEG_QUALITY` (0.82) in `pdfParser.ts` are untested starting points — if transcription quality is ever poor on a real document, check whether the rendered image is legible before assuming the prompt or the model is at fault.
```

- [ ] **Step 5: Commit**

```bash
git add docs/tuning-notes.md
git commit -m "Document the new ocr ceiling and record PDF OCR support's verification results"
```
