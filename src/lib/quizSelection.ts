import type { TestQuestion } from '../types';
import { shuffle } from './shuffle';
import { contentWords, hasConflictingNumbers, wordOverlap } from './textUtils';

/**
 * How alike two questions must be to count as the same question.
 *
 * The weight sits on the ANSWER, which is the opposite of the card thresholds in
 * cardValidation and deliberate: by this point the model has reworded both
 * cards, so two questions written from one fact often share little stem
 * vocabulary but must still reach the same answer. A matching stem with
 * different answers is two good questions about one topic, not a duplicate.
 *
 * See "Question de-duplication" in docs/tuning-notes.md for the measurements.
 */
const SAME_STEM = 0.5;
const SAME_ANSWER = 0.8;

/**
 * Too few words in an answer to read a high score as agreement.
 *
 * The same trap the card thresholds guard against, and sharper here because the
 * prompt caps options at fifteen words: a one-word answer is a subset of every
 * answer containing that word, so it scores 1.00 against them all. Two is the
 * lowest bar that closes the hole rather than a tuned figure — raising it would
 * start discarding the detections this exists for.
 */
const MIN_ANSWER_WORDS = 2;

/**
 * Choosing which questions a test asks, and in which order.
 *
 * Pure, and deliberately free of any database or DOM reference, so the whole
 * policy can be exercised under Node by the test harness. It is the piece most
 * worth testing automatically: the guarantee it makes is easy to state, easy to
 * get subtly wrong, and invisible when it breaks — a test that quietly asks the
 * same eight questions every time still looks like a working test.
 */

/**
 * Picks `n` questions, coldest first.
 *
 * Questions are tiered by how many times they have been asked, and a tier is
 * emptied before the next one is touched. That gives the guarantee people
 * actually want from "ask me different questions this time": nothing repeats
 * until everything has been asked once. Within a tier the order is random, so
 * two tests of the same size over the same pool are not the same test.
 *
 * Tiering rather than sorting on `lastAskedAt` is the point. A sort is
 * deterministic — the same pool and the same count would produce the same test
 * every time, which is the opposite of what was asked for. Tiering keeps the
 * strong no-repeat guarantee and leaves genuine randomness inside each tier.
 */
export function selectQuestions(pool: TestQuestion[], n: number): TestQuestion[] {
  const wanted = Math.max(0, Math.min(n, pool.length));
  if (wanted === 0) return [];

  const tiers = new Map<number, TestQuestion[]>();
  for (const question of pool) {
    const tier = tiers.get(question.timesAsked);
    if (tier) tier.push(question);
    else tiers.set(question.timesAsked, [question]);
  }

  /** A question with its words extracted, so a draw tokenizes each one once. */
  const weigh = (question: TestQuestion) => ({
    question,
    stem: contentWords(question.stem),
    answer: contentWords(question.correctAnswer),
  });
  type Weighed = ReturnType<typeof weigh>;

  const picked: Weighed[] = [];
  const skipped: Weighed[] = [];

  /**
   * True when a question asks what one already drawn asks.
   *
   * Decks written from documents that restate themselves carry pairs of cards
   * that mean the same thing, and each gets its own question. Drawn together
   * they make a test that asks the same thing twice with the same answer, which
   * reads as a bug in the test rather than a duplicate in the deck.
   *
   * Both halves have to match, for the same reason card de-duplication requires
   * it: several questions legitimately share most of their words while having
   * genuinely different answers.
   */
  const duplicates = (candidate: Weighed): boolean => {
    if (candidate.answer.size < MIN_ANSWER_WORDS) return false;

    return picked.some((kept) => {
      if (kept.answer.size < MIN_ANSWER_WORDS) return false;

      // Two questions quoting different figures are the two sides of a
      // distinction, however alike they read — and the figure that separates
      // them sits in the stem as often as in the answer. "What happens after 2
      // failed attempts?" and "…after 5…" share an answer word for word.
      if (hasConflictingNumbers(kept.question.correctAnswer, candidate.question.correctAnswer))
        return false;
      if (hasConflictingNumbers(kept.question.stem, candidate.question.stem)) return false;

      return (
        wordOverlap(kept.stem, candidate.stem) >= SAME_STEM &&
        wordOverlap(kept.answer, candidate.answer) >= SAME_ANSWER
      );
    });
  };

  for (const timesAsked of [...tiers.keys()].sort((a, b) => a - b)) {
    if (picked.length >= wanted) break;
    for (const question of shuffle(tiers.get(timesAsked)!)) {
      if (picked.length >= wanted) break;
      const candidate = weigh(question);
      if (duplicates(candidate)) skipped.push(candidate);
      else picked.push(candidate);
    }
  }

  // A short test beats a repetitive one, so a near-duplicate is dropped rather
  // than replaced — but only while something else was actually asked. A pool
  // that is entirely one question restated would otherwise yield a test of one,
  // so if nothing survived the filter the request is honoured as asked.
  if (picked.length === 0) picked.push(...skipped.slice(0, wanted));

  // Shuffled again so the least-asked questions are not all at the front. They
  // tend to come from the same part of the deck, which would otherwise sort the
  // test by topic as a side effect of sorting it by staleness.
  return shuffle(picked).map((entry) => entry.question);
}

/** One question as the test presents it: options in order, answer at an index. */
export interface PreparedQuestion {
  question: TestQuestion;
  options: string[];
  correctIndex: number;
}

/**
 * Lays a question out for asking, with its options in a fresh random order.
 *
 * The order is decided here, at presentation, rather than being stored. Models
 * have a habit of putting the correct answer first, and a stored order would
 * bake that habit into every sitting of the test.
 */
export function prepareQuestion(question: TestQuestion): PreparedQuestion {
  const options = shuffle([question.correctAnswer, ...question.distractors]);
  return {
    question,
    options,
    correctIndex: options.indexOf(question.correctAnswer),
  };
}

export function prepareQuestions(questions: TestQuestion[]): PreparedQuestion[] {
  return questions.map(prepareQuestion);
}
