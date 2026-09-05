import type { Flashcard, QuestionStyle, TestQuestion } from '../types';
import type { AiSettings } from './aiGenerator';
import { callModel } from './aiTransport';
import { runBatches, type BatchProgress } from './batchRunner';
import {
  parseQuizResponse,
  parseVignetteResponse,
  parseAuditResponse,
  type LlmQuizQuestion,
} from './quizPrompt';

/**
 * Writes multiple-choice questions from saved flashcards.
 *
 * Deliberately knows nothing about the database or the DOM: persistence happens
 * through the `onBatch` callback, and settings arrive as an argument rather than
 * being read from localStorage. That is what lets the whole generator run under
 * Node in the test harness, where distractor quality can actually be inspected.
 *
 * There is no rule-based fallback here, unlike card drafting. Rules can pull a
 * front and a back out of a document; nothing offline can invent three
 * plausible-but-wrong answers. So a batch that fails leaves those cards with no
 * question, and the caller has to say so rather than quietly running a shorter
 * test.
 */

/**
 * Cards per request.
 *
 * The binding constraint is the response ceiling in aiTransport, not the request
 * size: eight questions cost roughly a third of it, which is a margin rather
 * than a cliff. Eight also keeps a 100-card deck to 13 requests, comfortably
 * under the 20/min rate limit, where five would need 20 and sit right on it.
 *
 * See "Batch sizes" in docs/tuning-notes.md.
 */
const BATCH_SIZE = 8;

/**
 * Cards per request on the retry pass.
 *
 * Whatever cost the first pass its stragglers, a smaller batch is the one lever
 * that helps for every cause of it.
 */
const RETRY_BATCH_SIZE = 4;

/**
 * The same two numbers for board-style items, which cost about twice as much.
 *
 * A vignette is a four-sentence scenario, five options and an explanation where
 * a recall question is a stem and four short options. Halving the batch holds a
 * request the same distance from the ceiling as the recall path sits at.
 */
const VIGNETTE_BATCH_SIZE = 4;
const VIGNETTE_RETRY_BATCH_SIZE = 2;

/** Other cards offered per batch, as raw material for wrong answers. */
const NEIGHBOUR_LIMIT = 20;

/**
 * Related cards sent whole with a board-style batch, as source material.
 *
 * A vignette has to describe how something presents, and the only honest source
 * for that is other cards from the same lecture. Fewer than the recall path's
 * neighbours and given more room each, because a neighbour only has to be
 * recognisable as an option where a context card is read for the detail in it.
 */
const CONTEXT_LIMIT = 12;
const CONTEXT_CHARS = 200;

/** Longer than this and a neighbour is costing tokens without adding realism. */
const NEIGHBOUR_CHARS = 160;

/** A snippet longer than this is truncated before it goes to the model. */
const MAX_PROMPT_CODE_CHARS = 4000;

/** Batches are split again if their JSON would come near the server's cap. */
const MAX_PAYLOAD_CHARS = 100_000;

export interface QuizGenerationResult {
  questions: TestQuestion[];
  /** Cards that came back with nothing. Reported to the user, never hidden. */
  failedCardIds: string[];
  failedBatches: number;
  totalBatches: number;
  firstError: string | null;
  /**
   * Batches the model stopped writing because it hit the token ceiling.
   *
   * Kept apart from failedBatches because it needs a different sentence: a
   * truncated reply is the tool's fault and worth retrying, where a card the
   * model declined is a property of the card.
   */
  truncatedBatches: number;
  /** True when the user stopped the run. Not a failure, and not reported as one. */
  aborted: boolean;
}

export interface QuizGenerationOptions {
  onProgress?: (progress: BatchProgress) => void;
  /** Fired after each successful batch so the caller can save as it goes. */
  onBatch?: (questions: TestQuestion[]) => Promise<void>;
  signal?: AbortSignal;
  /** Which kind of question to write. Defaults to the recall style. */
  style?: QuestionStyle;
}

/**
 * A fingerprint of the text a question was written from.
 *
 * FNV-1a, chosen because it is synchronous and behaves identically in the
 * browser and under Node — `crypto.subtle.digest` is neither. It only has to
 * detect that a card changed, so collision resistance is not the property being
 * bought.
 */
export function hashCard(card: Pick<Flashcard, 'front' | 'back'>): string {
  const text = `${card.front}\u0000${card.back}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Cuts payload text at a character count, marking the cut on its own line.
 *
 * Blunt on purpose — this trims prose as often as code, and there is no line
 * boundary worth finding in a card's back. sectioning's truncateCode is the
 * snippet-aware one, and pageSource's shorten fits a label inside a width;
 * three contracts rather than one function with three flags.
 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…`;
}

/**
 * Cards from elsewhere in the deck, nearest first.
 *
 * The best wrong answer is a near miss the deck already contains — the adjacent
 * stage of a sequence, a sibling term, the next row of the same table — because
 * it tests whether the student can tell two real things apart. An unrelated fact
 * from forty pages away is a giveaway.
 *
 * So neighbours are gathered nearest-first: same topic, then same source page,
 * then whatever else the deck holds. Sending every answer in a large deck with
 * every batch would be unaffordable and would bury the useful ones.
 */
function nearestFirst(batch: Flashcard[], deckCards: Flashcard[]): Flashcard[] {
  const excluded = new Set(batch.map((card) => card.id));
  const topics = new Set(batch.map((card) => card.context).filter(Boolean));
  const sources = new Set(batch.map((card) => card.sourceLabel).filter(Boolean));

  const rank = (card: Flashcard): number => {
    if (card.context && topics.has(card.context)) return 0;
    if (card.sourceLabel && sources.has(card.sourceLabel)) return 1;
    return 2;
  };

  return deckCards.filter((card) => !excluded.has(card.id)).sort((a, b) => rank(a) - rank(b));
}

/** One card as a payload entry: whitespace collapsed and truncated to fit. */
interface TrimmedCard {
  front: string;
  back: string;
  topic: string | null;
}

/** Collapses a card's text to one line each, cut to `chars`. */
function trimCard(card: Flashcard, chars: number): TrimmedCard {
  return {
    front: truncate(card.front.replace(/\s+/g, ' ').trim(), chars),
    back: truncate(card.back.replace(/\s+/g, ' ').trim(), chars),
    topic: card.context ?? null,
  };
}

/**
 * Cards from around the batch, trimmed for the payload, nearest first.
 *
 * The one gatherer behind all three payload shapes. `dedupeOnBack` drops cards
 * whose answer repeats one already taken, which matters for a distractor list —
 * two identical wrong options waste a slot and read as a bug — and is skipped
 * for vignette context, where a repeated answer still carries different detail.
 */
function neighbours(
  batch: Flashcard[],
  deckCards: Flashcard[],
  { limit, chars, dedupeOnBack }: { limit: number; chars: number; dedupeOnBack: boolean }
): TrimmedCard[] {
  const seen = new Set<string>();
  const out: TrimmedCard[] = [];

  for (const card of nearestFirst(batch, deckCards)) {
    if (out.length >= limit) break;
    const trimmed = trimCard(card, chars);
    if (!trimmed.front || !trimmed.back) continue;

    if (dedupeOnBack) {
      const key = trimmed.back.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
    }

    out.push(trimmed);
  }

  return out;
}

/**
 * Neighbouring cards for a recall batch: both halves of each.
 *
 * The answers alone are what a distractor is made of, but the prompt's most
 * important check is whether a neighbour's answer is ALSO correct for the stem
 * being written — and a bare list of answers cannot show that. A deck that
 * states one fact twice otherwise offers a perfect near miss that is simply
 * right.
 *
 * See "Neighbour and context payloads" in docs/tuning-notes.md.
 */
function neighbourCards(batch: Flashcard[], deckCards: Flashcard[]) {
  return neighbours(batch, deckCards, {
    limit: NEIGHBOUR_LIMIT,
    chars: NEIGHBOUR_CHARS,
    dedupeOnBack: true,
  }).map(({ front, back }) => ({ front, back }));
}

/** The same neighbours as bare answers, which is all the vignette prompt reads. */
function neighbourAnswers(batch: Flashcard[], deckCards: Flashcard[]): string[] {
  return neighbours(batch, deckCards, {
    limit: NEIGHBOUR_LIMIT,
    chars: NEIGHBOUR_CHARS,
    dedupeOnBack: true,
  }).map((card) => card.back);
}

/**
 * Related cards sent whole, so a clinical scenario has something to stand on.
 *
 * An answer alone is enough to build a wrong option out of, but not to describe
 * a patient, and the only source for that which the student has been taught is
 * the rest of their own deck. This is the difference between a model drawing on
 * the lecture and a model drawing on itself.
 */
function contextCards(batch: Flashcard[], deckCards: Flashcard[]) {
  return neighbours(batch, deckCards, {
    limit: CONTEXT_LIMIT,
    chars: CONTEXT_CHARS,
    dedupeOnBack: false,
  });
}

/**
 * One batch as the model sees it.
 *
 * Cards are given short batch-local ids rather than their real 36-character
 * UUIDs: the model has to echo the id back, and a shorter one costs fewer
 * tokens and offers less to mistype.
 *
 * A snippet's text is sent — the model cannot ask what a program prints without
 * reading it — but an image's address never is. The model has no use for a URL
 * and would only be given the chance to invent one.
 */
function serializeBatch(
  batch: Flashcard[],
  deckCards: Flashcard[],
  deckName: string,
  style: QuestionStyle = 'recall'
) {
  return {
    deck: deckName,
    cards: batch.map((card, i) => ({
      id: `q${i + 1}`,
      front: card.front,
      back: card.back,
      topic: card.context ?? null,
      questionCode: card.frontCode
        ? { language: card.frontCode.language ?? null, text: truncate(card.frontCode.text, MAX_PROMPT_CODE_CHARS) }
        : null,
      answerCode: card.backCode
        ? { language: card.backCode.language ?? null, text: truncate(card.backCode.text, MAX_PROMPT_CODE_CHARS) }
        : null,
      diagramAlt: card.image?.alt ?? null,
    })),
    // The board-style payload is left exactly as it was measured: bare answers
    // for distractors, plus its own `context` block for grounding a scenario.
    neighbours:
      style === 'vignette'
        ? neighbourAnswers(batch, deckCards)
        : neighbourCards(batch, deckCards),
    // Only the board-style prompt knows what to do with these, and they are the
    // most expensive thing in the payload — no reason to send them otherwise.
    ...(style === 'vignette' ? { context: contextCards(batch, deckCards) } : {}),
  };
}

/** Splits cards into batches small enough for one request. */
function buildBatches(
  cards: Flashcard[],
  deckCards: Flashcard[],
  deckName: string,
  size: number = BATCH_SIZE,
  style: QuestionStyle = 'recall'
): Flashcard[][] {
  const batches: Flashcard[][] = [];
  for (let i = 0; i < cards.length; i += size) {
    batches.push(cards.slice(i, i + size));
  }

  // A deck of very long cards can still overshoot the server's payload cap, in
  // which case the batch is halved rather than left to come back as a 413.
  const sized: Flashcard[][] = [];
  for (const batch of batches) {
    const size = JSON.stringify(serializeBatch(batch, deckCards, deckName, style)).length;
    if (size <= MAX_PAYLOAD_CHARS || batch.length === 1) {
      sized.push(batch);
      continue;
    }
    const middle = Math.ceil(batch.length / 2);
    sized.push(batch.slice(0, middle), batch.slice(middle));
  }

  return sized;
}

/**
 * Runs the grounding/distractor-safety audit over one batch of vignette
 * questions, dropping any it flags — or all of them, if the audit call
 * itself fails.
 *
 * Failing closed here is deliberate: an unaudited vignette is exactly the
 * "confidently wrong" outcome this pass exists to catch, so a broken audit
 * call must not be treated as a pass. A dropped question is not lost — it is
 * simply a card without one yet, and is offered again on the retry pass like
 * any other, per the same philosophy `toQuestion()` already uses for a
 * malformed reply.
 */
async function auditVignettes(
  parsed: LlmQuizQuestion[],
  batch: Flashcard[],
  deckCards: Flashcard[],
  settings: AiSettings,
  signal?: AbortSignal
): Promise<LlmQuizQuestion[]> {
  const context = contextCards(batch, deckCards).map(({ front, back }) => ({ front, back }));
  const questions = parsed.map((item) => {
    const index = Number(item.id.replace(/^q/i, '')) - 1;
    const card = batch[index];
    return {
      id: item.id,
      card: card ? { front: card.front, back: card.back } : null,
      vignette: item.vignette ?? '',
      stem: item.stem,
      correct: item.correct,
      distractors: item.distractors,
    };
  });

  try {
    // Wrapped in an array for the same reason the generation call is: the
    // endpoint's contract is a non-empty list of things for the model, even
    // when — as here — there is only one thing to send.
    const { text } = await callModel('vignette-audit', [{ context, questions }], settings, signal);
    const verdicts = parseAuditResponse(text);
    return parsed.filter((item) => verdicts.get(item.id) === true);
  } catch (err) {
    console.error('Vignette audit failed; dropping the batch rather than trusting it unaudited:', err);
    return [];
  }
}

/**
 * Writes one question per card, as far as the model can.
 *
 * `targets` are the cards needing a question; `deckCards` is the whole deck,
 * used only to draw neighbouring answers from.
 */
export async function generateQuestionsForCards(
  targets: Flashcard[],
  deckCards: Flashcard[],
  deckName: string,
  settings: AiSettings,
  options: QuizGenerationOptions = {}
): Promise<QuizGenerationResult> {
  // Defaulted rather than required, so every existing call site keeps writing
  // recall questions without being touched.
  const style: QuestionStyle = options.style ?? 'recall';
  const isVignette = style === 'vignette';

  const questions: TestQuestion[] = [];
  let failedBatches = 0;
  let truncatedBatches = 0;
  let totalBatches = 0;
  let done = 0;
  let firstError: string | null = null;
  let aborted = false;

  /**
   * Runs one batch and returns the cards it left without a question.
   *
   * Throwing is reserved for a batch that produced nothing at all. A batch that
   * answered some of its cards is a partial success, and the ones it missed come
   * back here to be retried rather than being written off.
   */
  async function runBatch(batch: Flashcard[]): Promise<Flashcard[]> {
    // Wrapped in an array because the endpoint's contract is a non-empty
    // list of things for the model, and card drafting sends one section per
    // entry. A quiz batch is a single entry, but it still has to be a list.
    const { text, stopReason } = await callModel(
      isVignette ? 'vignette' : 'quiz',
      [serializeBatch(batch, deckCards, deckName, style)],
      settings,
      options.signal
    );
    if (stopReason === 'max_tokens') truncatedBatches += 1;

    let parsed = isVignette ? parseVignetteResponse(text) : parseQuizResponse(text);
    if (parsed.length === 0) {
      throw new Error(
        stopReason === 'max_tokens'
          ? 'The reply was cut off by the length limit before any question was complete.'
          : 'No questions returned'
      );
    }

    // Audited before anything is marked answered, so a question the audit
    // drops flows through exactly like one the model never wrote: its card
    // stays unanswered and is retried, rather than needing separate handling.
    if (isVignette) {
      parsed = await auditVignettes(parsed, batch, deckCards, settings, options.signal);
    }

    const now = Date.now();
    const written: TestQuestion[] = [];
    const answered = new Set<string>();

    for (const item of parsed) {
      // Batch-local ids are "q1".."qN"; anything else the model invented
      // resolves to no card and is dropped.
      const index = Number(item.id.replace(/^q/i, '')) - 1;
      const card = batch[index];
      if (!card || answered.has(card.id)) continue;
      answered.add(card.id);

      written.push({
        id: crypto.randomUUID(),
        deckId: card.deckId,
        cardId: card.id,
        style,
        // Absent when the card could not carry a scenario without inventing
        // findings and the model took the escape hatch, which is a correct
        // outcome rather than a missing field.
        vignette: item.vignette,
        stem: item.stem,
        correctAnswer: item.correct,
        distractors: item.distractors,
        explanation: item.explanation,
        stemCode: card.frontCode,
        stemImage: card.image,
        context: card.context,
        sourceLabel: card.sourceLabel,
        cardHash: hashCard(card),
        createdAt: now,
        timesAsked: 0,
        lastAskedAt: null,
        timesCorrect: 0,
      });
    }

    questions.push(...written);
    if (written.length > 0) await options.onBatch?.(written);

    return batch.filter((card) => !answered.has(card.id));
  }

  /**
   * Runs one pass over a list of batches, collecting the cards it did not cover.
   *
   * A batch that threw contributes all of its cards; a batch that answered some
   * of them contributes the rest. Both are simply cards without a question, and
   * are offered again rather than reported as an error.
   */
  async function runPass(batches: Flashcard[][]): Promise<Flashcard[]> {
    const missed: Flashcard[] = [];

    const outcome = await runBatches(
      batches,
      async (batch) => {
        missed.push(...(await runBatch(batch)));
      },
      {
        signal: options.signal,
        onProgress: options.onProgress,
        progressOffset: { done, total: totalBatches },
        onFailure: (batch, err) => {
          console.error('Quiz batch failed:', err);
          missed.push(...batch);
        },
      }
    );

    done += batches.length - outcome.remaining.length;
    totalBatches += batches.length;
    failedBatches += outcome.failedBatches;
    if (!firstError) firstError = outcome.firstError;
    if (outcome.aborted) aborted = true;

    // Whatever was already saved stays saved; the batches never reached are
    // cards without a question, which the top-up prompt already handles.
    for (const batch of outcome.remaining) missed.push(...batch);

    return missed;
  }

  const firstSize = isVignette ? VIGNETTE_BATCH_SIZE : BATCH_SIZE;
  const retrySize = isVignette ? VIGNETTE_RETRY_BATCH_SIZE : RETRY_BATCH_SIZE;

  let missing = await runPass(buildBatches(targets, deckCards, deckName, firstSize, style));

  // One bounded retry, in smaller batches. A card is only reported as missing
  // after the model has had a second, easier chance at it, which is what turns
  // "run it three times to fill a deck" into a single pass.
  if (missing.length > 0 && !aborted) {
    missing = await runPass(buildBatches(missing, deckCards, deckName, retrySize, style));
  }

  return {
    questions,
    failedCardIds: missing.map((card) => card.id),
    failedBatches,
    totalBatches,
    // Cancelling is not a failure, and reporting the abort as one told someone
    // who pressed Stop that their questions could not be written.
    firstError: aborted ? null : firstError,
    truncatedBatches,
    aborted,
  };
}
