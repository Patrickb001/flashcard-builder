import type { Flashcard, TestQuestion } from '../types';
import type { AiSettings } from './aiGenerator';
import { callModel } from './aiTransport';
import { parseQuizResponse } from './quizPrompt';

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
 * The binding constraint is the server's response ceiling, not the request
 * size. Measured on real cards, a question costs about 420 output tokens when
 * options run to full sentences, so ten needed ~4200 against a ceiling fixed at
 * 4000: batches came back stopped at exactly max_tokens, truncated mid-JSON,
 * and the salvage pass kept only the objects that had closed. That is why a run
 * covered roughly half a deck.
 *
 * The ceiling is now 8000 for quiz work and options are capped at 15 words
 * (~330 tokens a question), so eight cards costs ~2600 — a wide margin rather
 * than a cliff. Eight also keeps a 100-card deck to 13 requests, comfortably
 * under the 20/min limit; five would need 20 and sit right on it.
 */
const BATCH_SIZE = 8;

/**
 * Cards per request on the retry pass.
 *
 * Whatever cost the first pass its stragglers, a smaller batch is the one lever
 * that helps for every cause of it.
 */
const RETRY_BATCH_SIZE = 4;

/** Other answers offered per batch, as raw material for wrong answers. */
const NEIGHBOUR_LIMIT = 20;

/** Longer than this and a neighbour is costing tokens without adding realism. */
const NEIGHBOUR_CHARS = 160;

/** A snippet longer than this is truncated before it goes to the model. */
const MAX_CODE_CHARS = 4000;

/** Batches are split again if their JSON would come near the server's cap. */
const MAX_PAYLOAD_CHARS = 100_000;

export interface QuizProgress {
  done: number;
  total: number;
}

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
}

export interface QuizGenerationOptions {
  onProgress?: (p: QuizProgress) => void;
  /** Fired after each successful batch so the caller can save as it goes. */
  onBatch?: (questions: TestQuestion[]) => Promise<void>;
  signal?: AbortSignal;
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

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…`;
}

/**
 * Answers from elsewhere in the deck, as raw material for wrong answers.
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
function neighbourAnswers(batch: Flashcard[], deckCards: Flashcard[]): string[] {
  const excluded = new Set(batch.map((card) => card.id));
  const topics = new Set(batch.map((card) => card.context).filter(Boolean));
  const sources = new Set(batch.map((card) => card.sourceLabel).filter(Boolean));

  const rank = (card: Flashcard): number => {
    if (card.context && topics.has(card.context)) return 0;
    if (card.sourceLabel && sources.has(card.sourceLabel)) return 1;
    return 2;
  };

  const seen = new Set<string>();
  const answers: string[] = [];

  for (const card of [...deckCards].sort((a, b) => rank(a) - rank(b))) {
    if (answers.length >= NEIGHBOUR_LIMIT) break;
    if (excluded.has(card.id)) continue;
    const answer = truncate(card.back.replace(/\s+/g, ' ').trim(), NEIGHBOUR_CHARS);
    const key = answer.toLowerCase();
    if (!answer || seen.has(key)) continue;
    seen.add(key);
    answers.push(answer);
  }

  return answers;
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
function serializeBatch(batch: Flashcard[], deckCards: Flashcard[], deckName: string) {
  return {
    deck: deckName,
    cards: batch.map((card, i) => ({
      id: `q${i + 1}`,
      front: card.front,
      back: card.back,
      topic: card.context ?? null,
      questionCode: card.frontCode
        ? { language: card.frontCode.language ?? null, text: truncate(card.frontCode.text, MAX_CODE_CHARS) }
        : null,
      answerCode: card.backCode
        ? { language: card.backCode.language ?? null, text: truncate(card.backCode.text, MAX_CODE_CHARS) }
        : null,
      diagramAlt: card.image?.alt ?? null,
    })),
    neighbours: neighbourAnswers(batch, deckCards),
  };
}

/** Splits cards into batches small enough for one request. */
function buildBatches(
  cards: Flashcard[],
  deckCards: Flashcard[],
  deckName: string,
  size: number = BATCH_SIZE
): Flashcard[][] {
  const batches: Flashcard[][] = [];
  for (let i = 0; i < cards.length; i += size) {
    batches.push(cards.slice(i, i + size));
  }

  // A deck of very long cards can still overshoot the server's payload cap, in
  // which case the batch is halved rather than left to come back as a 413.
  const sized: Flashcard[][] = [];
  for (const batch of batches) {
    const size = JSON.stringify(serializeBatch(batch, deckCards, deckName)).length;
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
  const questions: TestQuestion[] = [];
  let failedBatches = 0;
  let truncatedBatches = 0;
  let totalBatches = 0;
  let done = 0;
  let firstError: string | null = null;

  /**
   * Runs one batch and returns the cards it left without a question.
   *
   * Throwing is reserved for a batch that produced nothing at all. A batch that
   * answered some of its cards is a partial success, and the ones it missed come
   * back here to be retried rather than being written off.
   */
  async function runBatch(batch: Flashcard[]): Promise<Flashcard[]> {
    try {
      // Wrapped in an array because the endpoint's contract is a non-empty
      // list of things for the model, and card drafting sends one section per
      // entry. A quiz batch is a single entry, but it still has to be a list.
      const { text, stopReason } = await callModel(
        'quiz',
        [serializeBatch(batch, deckCards, deckName)],
        settings,
        options.signal
      );
      if (stopReason === 'max_tokens') truncatedBatches += 1;

      const parsed = parseQuizResponse(text);
      if (parsed.length === 0) {
        throw new Error(
          stopReason === 'max_tokens'
            ? 'The reply was cut off by the length limit before any question was complete.'
            : 'No questions returned'
        );
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
    } catch (err) {
      console.error('Quiz batch failed:', err);
      failedBatches += 1;
      if (!firstError) firstError = err instanceof Error ? err.message : String(err);
      return batch;
    }
  }

  /** Runs a list of batches in order, stopping early if the user cancels. */
  async function runPass(batches: Flashcard[][]): Promise<Flashcard[]> {
    const missed: Flashcard[] = [];
    totalBatches += batches.length;

    for (let i = 0; i < batches.length; i++) {
      if (options.signal?.aborted) {
        // Whatever was already saved stays saved; the rest are simply cards
        // without a question, which the top-up prompt already handles.
        for (const remaining of batches.slice(i)) missed.push(...remaining);
        break;
      }
      missed.push(...(await runBatch(batches[i])));
      done += 1;
      options.onProgress?.({ done, total: totalBatches });
    }

    return missed;
  }

  let missing = await runPass(buildBatches(targets, deckCards, deckName));

  // One bounded retry, in smaller batches. A card is only reported as missing
  // after the model has had a second, easier chance at it, which is what turns
  // "run it three times to fill a deck" into a single pass.
  if (missing.length > 0 && !options.signal?.aborted) {
    missing = await runPass(buildBatches(missing, deckCards, deckName, RETRY_BATCH_SIZE));
  }

  return {
    questions,
    failedCardIds: missing.map((card) => card.id),
    failedBatches,
    totalBatches,
    firstError,
    truncatedBatches,
  };
}
