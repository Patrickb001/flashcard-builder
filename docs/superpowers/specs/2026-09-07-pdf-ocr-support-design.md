# PDF OCR Support — Design

**Goal:** When a PDF page has no extractable text (a scanned or photographed page), read it with Claude's vision instead of silently dropping it or failing the whole upload. Triggered by the test PDF at `docs/pdf-test/EXAM 1 STUDY GUIDE.pdf` — 16 pages, ~107MB, every page a single full-page image with zero embedded text, which `pdfParser.ts` today either drops per-page (mixed PDF) or fails entirely (fully-scanned PDF) with "Couldn't find any text in that file."

OCR only runs when AI drafting is on (reuses the existing hosted/BYOK Claude pipeline — no dedicated OCR library, no new API key) and only for pages with zero extractable text (a page with real text plus an illustrative diagram is untouched). Both confirmed in brainstorming.

## Data model

`src/lib/documentModel.ts` gains one new type and one new optional field:

```ts
/** One page pdf.js found no text on. Always produced for a zero-text PDF page;
 *  `image` is populated only when the caller asked for OCR rendering. */
export interface OcrPage {
  pageNum: number;
  /** "Page N" — matches the label a text-bearing page from the same document carries. */
  label: string;
  /** Bare base64 JPEG (no `data:` prefix), present only when rendered. */
  image?: string;
}
```

`DocumentSection` gains `pageNum?: number` — set by `pdfParser.ts` for every section it produces (both text-extracted and OCR-transcribed), left `undefined` by every other format's parser. Its only consumer is the merge-by-page-order step in `CandidateReview` (below); it is not part of the contract other parsers need to honor.

## Parsing: `src/lib/pdfParser.ts`

`extractPdfSections` gains an options parameter and returns both sections and any pages it could not read as text:

```ts
export async function extractPdfSections(
  file: File,
  options: { ocrEnabled: boolean } = { ocrEnabled: false }
): Promise<{ sections: DocumentSection[]; ocrPages: OcrPage[] }>
```

- `ocrEnabled: false` — a page yielding zero text items still produces an `OcrPage` entry (`pageNum`, `label`) so the caller can report *that* scanned pages exist — but nothing is rendered, so `image` is always left `undefined`. This detection is free (it falls out of the existing per-page loop); only the rendering step is skippable work, and it's skipped whenever OCR can't be used anyway.
- `ocrEnabled: true` — the same zero-text page is, in that same loop iteration (no second pass over the file), also rendered to a JPEG: `page.getViewport({scale: PDF_RENDER_SCALE})` → render into a canvas → `canvas.toBlob('image/jpeg', PDF_RENDER_JPEG_QUALITY)` → `FileReader.readAsDataURL` → strip the `data:` prefix for the bare base64 string, stored as `image`. Rendering (not detection) is capped at `MAX_OCR_PAGES`: pages beyond the cap are omitted from `ocrPages` entirely (no image, no metadata entry either — see Non-goals).
- So `image`'s presence is unambiguous: **set** means OCR ran (or will run) for that page; **absent** means either `ocrEnabled` was false, or a real (rare) render failure. Every entry in `ocrPages` when `ocrEnabled` is true has an image, up to the cap.
- Starting constants (tunable — this codebase already tracks tuned-by-testing constants in `docs/tuning-notes.md`, and these should join that once exercised against real documents): `PDF_RENDER_SCALE = 1.5` (~108 DPI), `PDF_RENDER_JPEG_QUALITY = 0.82`, `MAX_OCR_PAGES = 24`.

## Getting the images from Upload to Review without the History API

`ReviewDraft` (`src/routes/reviewDraft.ts`) travels as React Router `location.state`, which is subject to the browser History API's state-size limits (historically as low as ~640KB in some browsers). A handful of rendered page JPEGs for a 16+ page scan can easily exceed that, which would make `navigate('/review', {state})` throw. So `OcrPage[]` (with image data) does **not** travel through `ReviewDraft`/router state at all — `ReviewDraft` is untouched.

Instead, a tiny same-tab, in-memory handoff module, `src/lib/ocrPageHandoff.ts`:

```ts
let pending: OcrPage[] = [];
export function stashOcrPages(pages: OcrPage[]): void { pending = pages; }
export function readOcrPages(): OcrPage[] { return pending; }
```

`Uploader.tsx`'s `handleFile` calls `stashOcrPages([])` unconditionally at the top, before any format-specific parsing — this is what stops a stale scan from a cancelled/earlier upload leaking into an unrelated deck. Its PDF branch then calls `stashOcrPages(ocrPages)` with the real result before calling `onParsed(...)` (whose signature does not change). `ReviewRoute.tsx` calls `readOcrPages()` (non-destructively — reading twice, e.g. from a StrictMode double-render, is safe and idempotent) and passes the result to `CandidateReview` as a new `ocrPages?: OcrPage[]` prop, keeping `CandidateReview` itself pure (data arrives via props, same as `sections`/`notice`/`sourceUrls` today).

## OCR drafting: `src/lib/ocrPrompt.ts` + `src/lib/ocrGenerator.ts`

New system prompt, same file-per-concern convention as `cardPrompt.ts`/`quizPrompt.ts`:

```ts
export const OCR_SYSTEM_PROMPT = `You are given one or more scanned or photographed pages from a study document, each labeled with the page it came from. Transcribe the readable text of each page faithfully.

Rules:
1. Preserve headings, paragraphs, and bullet lists as separate blocks. Do not summarize or paraphrase — transcribe what is written.
2. Never invent text you cannot read. Skip illegible words, illegible lines, or illegible pages entirely rather than guessing at their content.
3. Ignore page furniture: page numbers, headers/footers, watermarks, scan artifacts.
4. Work through the pages in the order given, one entry per page.

Return ONLY a JSON array, no markdown fence, no commentary. Each element:
{"page": string, "title": string | null, "blocks": [{"type": "heading", "text": string} | {"type": "paragraph", "heading": string | null, "text": string} | {"type": "list", "heading": string | null, "items": string[]}]}

"page" is the page's label, copied exactly from what you were given. A page with nothing legible on it still gets an entry, with an empty "blocks" array.`;
```

`parseOcrResponse(text, pages)` mirrors `parseCardsResponse`'s tolerant-of-truncation shape: `parseJsonArray(text)`, filtered to well-formed entries, mapped back to the real `OcrPage` by `page` label (a `Map`, same defensive-lookup pattern `aiGenerator.ts`'s `runBatch` already uses for card `source`), converted into real `DocumentSection` objects (`pageNum` copied from the matched `OcrPage`, blocks converted 1:1, `applyContext` run the same way every other parser runs it).

`transcribePagesWithAi(pages: OcrPage[], settings: AiSettings, options): Promise<OcrResult>` mirrors `generateCandidatesWithAi`'s batch/retry structure (reusing `runBatches`, calling `callModel('ocr', ...)`), adapted for sections instead of cards:

```ts
export interface OcrResult {
  sections: DocumentSection[];
  /** Labels of pages no batch ever produced a transcription for. Nothing to
   *  fall back to here — unlike card drafting, there is no rule-based path
   *  for a page with no text at all. */
  failedPages: string[];
  failedBatches: number;
  totalBatches: number;
  truncatedBatches: number;
  firstError: string | null;
  aborted: boolean;
}
```

Same two-pass shape as card drafting: an initial pass at `OCR_BATCH_SIZE = 3` pages/request, then one retry pass at `OCR_RETRY_BATCH_SIZE = 1` for anything a truncated reply left uncovered, before a page is finally counted in `failedPages`.

Each batch's `callModel('ocr', payload, settings, signal, images)` call sends `images` as the batch's JPEGs in order, and `payload` as the small manifest `[{page: label}, ...]` in that same order — this is what the model echoes back via `"page"` in its response, and what `parseOcrResponse` matches against.

## Transport: `src/lib/aiTransport.ts` + `src/server/generateHandler.ts`

- `AiTask` gains `'ocr'`; `MAX_TOKENS.ocr = 16000` (client and server copies, kept in sync exactly as the existing four already are — see the "must stay in step" comments already in both files).
- `callModel` gains a fifth, optional parameter: `callModel(task, payload, settings, signal?, images?: string[])`. Existing call sites (`aiGenerator.ts`, `quizGenerator.ts`) are unaffected — they never pass a fifth argument.
- `callHosted` and `callDirect` both thread `images` through:
  - `callHosted` POSTs `{task, sections: payload, images}` — when `images` is `undefined`, `JSON.stringify` drops the key, so the wire shape for every existing task is unchanged.
  - `callDirect` builds Anthropic's multimodal `content` shape only when `images` is non-empty: `[...images.map(data => ({type:'image', source:{type:'base64', media_type:'image/jpeg', data}})), {type:'text', text: JSON.stringify(payload)}]`; otherwise keeps today's bare-string `content`.
- `generateHandler.ts`'s `handleGenerate` reads an optional `images` field off the body. When present: validated as an array of non-empty strings, capped at `MAX_OCR_IMAGES = 4` entries and `MAX_IMAGE_BASE64_CHARS = 2_000_000` (≈1.5MB raw) each — rejected with 413 otherwise, mirroring the existing `MAX_REQUEST_CHARS` check (which stays as-is, applying to the text portion of every task including OCR's small page-label manifest). When valid, the upstream Anthropic request body's `content` is built the same multimodal way as `callDirect`. `netlify/functions/generate.mts` and `vite.config.ts` need no changes — both are thin adapters over `handleGenerate`, which is the one place this logic lives.
- The 4-image/1.5MB-per-image caps are sized to stay comfortably under Netlify's ~6MB synchronous function payload limit even at the cap.

## `CandidateReview.tsx` integration

New prop `ocrPages?: OcrPage[]` (from `ReviewRoute`, per above). The existing drafting `useEffect` (keyed on `sections`/`ai`/`sourceType`, unaffected by `ocrPages` not existing for non-PDF sources) gains a pre-step, only entered when `ocrPages.length > 0`:

1. Show a "reading scanned pages" phase — a second `DraftingBanner`/`ProgressBar` pairing (new `ocrProgress` state), reusing the exact same components card drafting already shows for its own progress, just a different activity string and shown first.
2. `transcribePagesWithAi(ocrPages, ai, {onProgress, signal})`.
3. Merge the result into the working section list: `[...sections, ...ocrResult.sections].sort((a, b) => (a.pageNum ?? 0) - (b.pageNum ?? 0))`. From this point on the merged list is what proceeds into the existing `generateCandidatesWithAi(...)` call, completely unchanged — OCR'd pages get real AI-drafted cards, and rule-based fallback cards too if their card drafting specifically fails, exactly like any other section.
4. If `ocrResult.failedPages.length > 0`, surface it with the same `ai-notice partial` treatment already used for "N cards fell back to rule-based" — informational only, no "add rule-based cards" offer (there is nothing to fall back to for a page with no text).

AI mode off: `ocrPages` may still be non-empty (metadata-only entries, no `image` — see the Parsing section), but this pre-step is unreachable regardless, because `CandidateReview`'s drafting effect already returns immediately at the top when `ai.mode === 'off'`, before it ever looks at `ocrPages`. `CandidateReview` behaves exactly as it does today whenever AI is off.

## `Uploader.tsx`

The PDF branch calls `extractPdfSections(file, { ocrEnabled: ai.mode !== 'off' })`, unconditionally stashes the result (per the handoff module above — harmless when AI is off, since `CandidateReview`'s drafting effect already returns immediately in that case, before ever looking at `ocrPages`), and its failure/notice logic becomes:

- `sections.length === 0 && ocrPages.length === 0` — truly nothing readable at all (corrupt/empty file). Unchanged generic error.
- `sections.length === 0 && ocrPages.length > 0 && ai.mode === 'off'` — a fully-scanned PDF with AI off. Today's "Couldn't find any text" error, with one sentence added pointing at the fix: "...it looks like a scanned/photographed PDF — turn on AI drafting above and try again so the model can read it."
- `sections.length === 0 && ocrPages.length > 0 && ai.mode !== 'off'` — a fully-scanned PDF with AI on. No error: proceeds to `onParsed(...)` exactly as a normal upload, and `CandidateReview` OCRs every page.
- `sections.length > 0 && ocrPages.length > 0 && ai.mode === 'off'` — a mixed PDF (some real text, some scanned) with AI off. Proceeds with just `sections`, but passes a `notice` (the same `notice?: string` parameter `onParsed` already carries for the "some sources were skipped" URL-fetch case) reading: "N page(s) look like scanned images and have no readable text — turn on AI drafting above to read them."
- `sections.length > 0 && ocrPages.length > 0 && ai.mode !== 'off'` — a mixed PDF with AI on. Proceeds with both; `CandidateReview` OCRs the scanned pages and merges them in.

## Non-goals

- pptx/html/md parsers are untouched — this is a PDF-specific problem (the only format that can have zero text on a page in the first place).
- No client-side OCR library (Tesseract.js or otherwise) — ruled out in brainstorming in favor of Claude's vision.
- No new required API key/credential — reuses the existing Anthropic key, hosted or BYOK, exactly like every other AI feature here.
- The OCR prompt asks for heading/paragraph/list only — no attempt to reconstruct a `TableBlock` from a scanned table, or to detect `code`/`image` blocks from a photographed page. A scanned page containing a table gets its rows read as flowing paragraph text. Revisit only if real output quality demands it.
- Trigger stays strictly "zero extractable text on the page" — a page with real text plus an embedded diagram is not re-OCR'd (confirmed in brainstorming).
- No special messaging when `MAX_OCR_PAGES` is exceeded — the overflow pages are silently omitted from `ocrPages` (not rendered, not reported), same as today's blanket behavior for zero-text pages before this feature existed.

## Verification

- `npx tsc -b` and `npm run build` must both pass.
- Manual pass with `npm run dev`, AI mode on (hosted or BYOK): upload `docs/pdf-test/EXAM 1 STUDY GUIDE.pdf`, confirm the OCR progress phase appears, transcribed sections make it into the candidate review list with real drafted cards, and page order in the review list matches the source document.
- Manual pass with AI mode off: same file, confirm today's "Couldn't find any text" error still appears (now mentioning AI mode), and no OCR-related network calls fire.
- Manual pass with a mixed PDF (some real-text pages, some scanned) — construct one or reuse an existing test fixture — AI on: confirm text pages parse normally, scanned pages get transcribed, and the merged deck's cards appear in the right page order.
- Since this project has no automated test suite (`package.json` has no `test` script), verification is `tsc`/`build` plus the manual passes above, consistent with how prior UI/pipeline changes in this repo have been verified.
