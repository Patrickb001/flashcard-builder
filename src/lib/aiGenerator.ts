import type { DocumentSection } from './documentModel';
import type { CandidateCard, CardCode, CardImage } from '../types';
import { parseCardsResponse } from './cardPrompt';
import { callModel } from './aiTransport';
import { runBatches, type BatchProgress } from './batchRunner';
import { dedupeCards, isUsableCard } from './cardValidation';
import { generateCandidates } from './flashcardGenerator';

/**
 * AI drafting. Two transports:
 *
 *  - "hosted": POST to /api/generate, a serverless function that holds the API
 *    key server-side. This is what visitors to a deployed site use, so nobody
 *    needs a key of their own.
 *  - "byok":   call the Anthropic API directly from the browser with a key the
 *    user pasted. Useful when running locally with no backend.
 *
 * Either way the model receives the structured blocks, never raw page text.
 */

export type AiMode = 'off' | 'hosted' | 'byok';

const SETTINGS_KEY = 'flashcard-forge:ai';

/** Sections per request, at most. Yield usually closes a batch first. */
const BATCH_SIZE = 4;

/**
 * Sections per request on the retry pass.
 *
 * One. Whatever cost a section its cards on the first pass, a request carrying
 * nothing else is the most headroom it can be given, and by this point there
 * are only a handful left.
 */
const RETRY_BATCH_SIZE = 1;

/**
 * Estimated cards a batch may ask for before it is closed.
 *
 * Counting sections was the wrong measure. Four pages of a title slide and a
 * bulleted agenda are nothing; four pages of a clinical reference deck are four
 * tables and sixteen bulleted quadrants, and the prompt asks for a card per
 * cell and per defined term. The second kind overran the response ceiling and
 * lost the whole batch, so batches are now closed on what they are likely to
 * produce rather than on how many pages went in.
 *
 * Forty cards is roughly 3000 output tokens against a 16000 ceiling. The
 * estimate below is deliberately crude, and the margin is what covers it being
 * wrong by a factor of several.
 */
const MAX_BATCH_CARDS = 40;

/** Batches are split again if their JSON would come near the server's cap. */
const MAX_PAYLOAD_CHARS = 100_000;

export interface AiSettings {
  mode: AiMode;
  apiKey?: string;
}

export function loadAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { mode: 'off' };
    const parsed = JSON.parse(raw) as AiSettings;
    return { mode: parsed.mode ?? 'off', apiKey: parsed.apiKey };
  } catch {
    return { mode: 'off' };
  }
}

export function saveAiSettings(settings: AiSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable in private browsing; drafting still works.
  }
}

/**
 * The snippets and diagrams a batch offers the model, by id.
 *
 * Ids run across the whole batch rather than per section: the model answers for
 * the batch as a whole, and two sections in it would otherwise both claim "c1".
 */
interface AssetTable {
  code: Map<string, CardCode>;
  images: Map<string, CardImage>;
}

/**
 * Compact JSON payload for one batch — structure preserved, noise dropped.
 *
 * Snippets and images go over with an id beside them. The model attaches one to
 * a card by naming its id and the real content is put back here afterwards, so
 * a program is never routed through the model's own output — where a single
 * typo would land in the one part of a card that has to be exact, and where an
 * image address would simply be invented.
 */
function serializeBatch(sections: DocumentSection[]): { payload: unknown[]; assets: AssetTable } {
  const assets: AssetTable = { code: new Map(), images: new Map() };

  const payload = sections.map((section) => ({
    source: section.label,
    title: section.title ?? null,
    blocks: section.blocks.map((b) => {
      switch (b.kind) {
        case 'heading':
          return { type: 'heading', level: b.level, text: b.text };
        case 'paragraph':
          return { type: 'paragraph', label: b.heading ?? null, text: b.text };
        case 'list':
          return { type: 'list', label: b.heading ?? null, items: b.items };
        case 'table':
          return { type: 'table', headers: b.headers, rows: b.rows };
        case 'code': {
          const id = `c${assets.code.size + 1}`;
          assets.code.set(id, { text: b.text, language: b.language });
          return {
            type: 'code',
            id,
            language: b.language ?? null,
            label: b.heading ?? null,
            text: b.text,
            output: b.output ?? null,
            alsoIn: b.alsoIn?.length ? b.alsoIn : null,
          };
        }
        case 'image': {
          const id = `i${assets.images.size + 1}`;
          assets.images.set(id, { src: b.src, alt: b.alt });
          // The address is withheld on purpose: it is of no use to the model
          // and every byte of it would be spent for nothing.
          return {
            type: 'image',
            id,
            label: b.heading ?? null,
            alt: b.alt ?? null,
            caption: b.caption ?? null,
          };
        }
      }
    }),
  }));

  return { payload, assets };
}

/**
 * Roughly how many cards a section is likely to be worth.
 *
 * The prompt's own rules are the estimate: a card per list item, a card per
 * meaningful table cell, a card per paragraph. Headings are context rather than
 * content and cost nothing. A table's first column is its row labels, so it is
 * excluded — a six-row table of two compared things is twelve cards, not
 * eighteen.
 *
 * Only ever used to decide where to close a batch, so being wrong by a little
 * costs nothing and being wrong by a lot costs one retry.
 */
export function estimateCards(section: DocumentSection): number {
  let cost = 0;
  for (const block of section.blocks) {
    switch (block.kind) {
      case 'heading':
        break;
      case 'list':
        cost += block.items.length;
        break;
      case 'table':
        cost += block.rows.length * Math.max(1, block.headers.length - 1);
        break;
      default:
        cost += 1;
    }
  }
  return cost;
}

/**
 * Splits sections into batches small enough for one request.
 *
 * Four caps, in order: never span two source documents, at most `maxSections`
 * sections, at most `MAX_BATCH_CARDS` estimated cards, and at most
 * `MAX_PAYLOAD_CHARS` of JSON.
 *
 * A single section that is worth more than the yield cap on its own still goes
 * out alone rather than being dropped — there is nothing smaller to split it
 * into, and the retry pass and the salvage parser are what cover it.
 */
export function buildBatches(
  sections: DocumentSection[],
  maxSections: number
): DocumentSection[][] {
  const batches: DocumentSection[][] = [];
  let cost = 0;

  for (const section of sections) {
    const current = batches[batches.length - 1];
    const sectionCost = estimateCards(section);
    // Batches never span two source documents: a card names the section it came
    // from, and two documents can both call a section "Page 1".
    const sameSource = current && current[0].group === section.group;

    if (
      current &&
      sameSource &&
      current.length < maxSections &&
      cost + sectionCost <= MAX_BATCH_CARDS
    ) {
      current.push(section);
      cost += sectionCost;
    } else {
      batches.push([section]);
      cost = sectionCost;
    }
  }

  // A batch of unusually wordy sections can still overshoot the server's
  // payload cap, in which case it is halved rather than left to come back a 413.
  const sized: DocumentSection[][] = [];
  for (const batch of batches) {
    const { payload } = serializeBatch(batch);
    if (JSON.stringify(payload).length <= MAX_PAYLOAD_CHARS || batch.length === 1) {
      sized.push(batch);
      continue;
    }
    const middle = Math.ceil(batch.length / 2);
    sized.push(batch.slice(0, middle), batch.slice(middle));
  }

  return sized;
}

/** The same shape question writing reports; one definition, two features. */
export type AiProgress = BatchProgress;

export interface AiGenerationOptions {
  onProgress?: (p: AiProgress) => void;
  signal?: AbortSignal;
}

export interface AiGenerationResult {
  cards: CandidateCard[];
  failedBatches: number;
  totalBatches: number;
  firstError: string | null;
  /** Labels of the sections that ended up with rule-based cards. */
  failedSections: string[];
  /**
   * Batches the model stopped writing because it hit the token ceiling.
   *
   * Kept apart from failedBatches because it needs a different sentence: a
   * truncated reply is the tool's fault and worth retrying, where a section the
   * model declined is a property of the section.
   */
  truncatedBatches: number;
  /** True when the user stopped the run. Not a failure, and not reported as one. */
  aborted: boolean;
}

/**
 * Drafts cards with the model, batch by batch.
 *
 * Sections the model could not cover are offered again in smaller batches before
 * anything is written off, and only what is still empty after that falls back to
 * the rule-based generator. A document therefore degrades one page at a time
 * instead of losing a whole batch to a single overrun.
 */
export async function generateCandidatesWithAi(
  sections: DocumentSection[],
  settings: AiSettings,
  options: AiGenerationOptions = {}
): Promise<AiGenerationResult> {
  /**
   * Cards by the section they came from.
   *
   * Keyed by the section itself rather than its label, because two documents in
   * one deck can each have a "Page 1". Collecting here and flattening in the
   * original order at the end is what lets the retry pass run out of order
   * without shuffling the deck.
   */
  const bySection = new Map<DocumentSection, CandidateCard[]>();

  let failedBatches = 0;
  let truncatedBatches = 0;
  let totalBatches = 0;
  let done = 0;
  let firstError: string | null = null;
  let aborted = false;

  /**
   * Runs one batch and returns the sections it left without cards.
   *
   * Throwing is reserved for a batch that produced nothing at all. A batch that
   * covered some of its sections is a partial success, and the ones it ran out
   * of room for come back here to be retried rather than being written off.
   *
   * A section the model finished and deliberately gave no cards is NOT missed.
   * The prompt tells it to return nothing for a section with nothing worth
   * learning, and a title slide taking that option is the prompt working. Only
   * a reply cut off by the ceiling leaves genuinely unanswered sections behind.
   */
  async function runBatch(batch: DocumentSection[]): Promise<DocumentSection[]> {
    const { payload, assets } = serializeBatch(batch);
    const { text, stopReason } = await callModel('cards', payload, settings, options.signal);
    const truncated = stopReason === 'max_tokens';
    if (truncated) truncatedBatches += 1;

    const parsed = parseCardsResponse(text);
    if (parsed.length === 0) {
      throw new Error(
        truncated
          ? 'The reply was cut off by the length limit before any card was complete.'
          : 'No cards returned'
      );
    }

    // Within a batch every section belongs to one document, so labels are
    // unique and a label is enough to find the section again.
    const byLabel = new Map(batch.map((section) => [section.label, section]));
    const covered = new Set<DocumentSection>();

    for (const card of parsed) {
      // A source the model invented resolves to nothing and the card is filed
      // under the batch's first section — the same defensive posture as the
      // asset ids, which is the whole point of handing over labels to echo.
      const section = (card.source && byLabel.get(card.source)) || batch[0];
      covered.add(section);

      const list = bySection.get(section);
      const entry: CandidateCard = {
        front: card.front,
        back: card.back,
        context: card.context || section.title,
        sourceLabel: section.label,
        // An id the model invented resolves to nothing and is dropped, which
        // is the whole point of handing over ids rather than content.
        frontCode: card.frontCode ? assets.code.get(card.frontCode) : undefined,
        backCode: card.backCode ? assets.code.get(card.backCode) : undefined,
        image: card.image ? assets.images.get(card.image) : undefined,
        include: true,
      };
      if (list) list.push(entry);
      else bySection.set(section, [entry]);
    }

    return truncated ? batch.filter((section) => !covered.has(section)) : [];
  }

  /** Runs one pass over a list of batches, collecting the sections it did not cover. */
  async function runPass(batches: DocumentSection[][]): Promise<DocumentSection[]> {
    const missed: DocumentSection[] = [];

    const outcome = await runBatches(batches, async (batch) => {
      missed.push(...(await runBatch(batch)));
    }, {
      signal: options.signal,
      onProgress: options.onProgress,
      progressOffset: { done, total: totalBatches },
      onFailure: (batch, err) => {
        console.error('AI batch failed:', err);
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

  let missing = await runPass(buildBatches(sections, BATCH_SIZE));

  // One bounded retry, one section at a time. A page is only given up on after
  // the model has had a second, easier chance at it.
  if (missing.length > 0 && !aborted) {
    missing = await runPass(buildBatches(missing, RETRY_BATCH_SIZE));
  }

  // Only now does anything fall back to rules, and only the pages that are
  // still empty. Cancelling is not a failure, so a stopped run keeps what it
  // drafted and leaves the rest alone rather than filling it with weaker cards.
  const failedSections: string[] = [];
  if (!aborted) {
    for (const section of missing) {
      if (bySection.has(section)) continue;
      failedSections.push(section.label);
      bySection.set(section, generateCandidates([section]));
    }
  }

  // Flattened in the document's own order, not the order the passes ran in.
  const all: CandidateCard[] = [];
  for (const section of sections) {
    const cards = bySection.get(section);
    if (cards) all.push(...cards);
  }

  return {
    cards: dedupeCards(all.filter(isUsableCard)),
    failedBatches,
    totalBatches,
    // Cancelling is not a failure, and reporting the abort as one would tell
    // someone who navigated away that their cards could not be drafted.
    firstError: aborted ? null : firstError,
    failedSections,
    truncatedBatches,
    aborted,
  };
}
