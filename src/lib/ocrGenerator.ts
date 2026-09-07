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
