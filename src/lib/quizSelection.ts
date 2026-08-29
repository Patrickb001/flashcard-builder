import type { TestQuestion } from '../types';
import { shuffle } from './shuffle';

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

  const picked: TestQuestion[] = [];
  for (const timesAsked of [...tiers.keys()].sort((a, b) => a - b)) {
    if (picked.length >= wanted) break;
    const tier = shuffle(tiers.get(timesAsked)!);
    picked.push(...tier.slice(0, wanted - picked.length));
  }

  // Shuffled again so the least-asked questions are not all at the front. They
  // tend to come from the same part of the deck, which would otherwise sort the
  // test by topic as a side effect of sorting it by staleness.
  return shuffle(picked);
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
