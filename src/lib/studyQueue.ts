import type { Flashcard } from '../types';
import { isDue, isNew } from './scheduling';
import { shuffle as defaultShuffle } from './shuffle';

/**
 * Which cards a study session shows, and in which order.
 *
 * Pure and free of React and IndexedDB, like quizSelection, so the policy runs
 * under Node in tools/test-scheduling.mjs. A queue is a list of card IDS, not
 * cards: StudyMode looks each one up in its current cards on render, so a card
 * updated by a grade is never served as the stale object it was when the
 * queue was built.
 */

/**
 * `review` is the default: what is due, then a bounded helping of new cards.
 * `all` is the old behaviour — every card in the deck — kept for cramming.
 */
export type StudySessionMode = 'review' | 'all';

/** New cards introduced per review session. Anki's default, and a sane daily load. */
export const NEW_PER_SESSION = 20;

/** Cards shown between a miss and its retry, so the retry is recall rather than echo. */
export const REQUEUE_GAP = 3;

/** Reads the `?mode=` search param. Anything but "all" is a review session. */
export function parseStudyMode(value: string | null): StudySessionMode {
  return value === 'all' ? 'all' : 'review';
}

export interface QueueOptions {
  newLimit?: number;
  /** Injected so the harness can make ordering deterministic. */
  shuffle?: <T>(items: T[]) => T[];
}

/**
 * The cards for one session, as ids, in the order they are shown.
 *
 * Review: due cards first, shuffled so one topic is not drilled in a block,
 * then up to `newLimit` new cards in deck order — a document builds on itself,
 * so new material is met in the order it was written. `cards` is expected in
 * deck order, which is how getCardsForDeck returns them.
 *
 * All: every card in deck order. The caller shuffles if asked to.
 */
export function buildQueue(
  cards: Flashcard[],
  mode: StudySessionMode,
  now: number,
  options: QueueOptions = {}
): string[] {
  if (mode === 'all') return cards.map((card) => card.id);

  const shuffle = options.shuffle ?? defaultShuffle;
  const newLimit = options.newLimit ?? NEW_PER_SESSION;
  const due = shuffle(cards.filter((card) => isDue(card, now)));
  const fresh = cards.filter(isNew).slice(0, Math.max(0, newLimit));
  return [...due, ...fresh].map((card) => card.id);
}

/**
 * The queue with a missed card due again a few cards later.
 *
 * `position` is the index of the card just graded. The retry lands REQUEUE_GAP
 * cards after it, or at the end when fewer remain. A later miss of the same
 * card requeues it again; there is no cap, because leaving is always one
 * button away and a card still missed at the end stays due for next time.
 */
export function requeue(queue: string[], position: number, cardId: string, gap = REQUEUE_GAP): string[] {
  const at = Math.min(position + 1 + gap, queue.length);
  return [...queue.slice(0, at), cardId, ...queue.slice(at)];
}

/** How many cards are due, and how many are new, as of `now`. */
export function countStudyable(cards: Flashcard[], now: number): { due: number; new: number } {
  let due = 0;
  let fresh = 0;
  for (const card of cards) {
    if (isNew(card)) fresh += 1;
    else if (isDue(card, now)) due += 1;
  }
  return { due, new: fresh };
}

/**
 * What a review session started now would hold: every due card, and new cards
 * up to `newLimit` — the same arithmetic as buildQueue, without building the
 * queue. For the deck manager's "Next session" summary, which has to promise
 * exactly what the study screen will serve. `nextDue` is set only when the
 * session would be empty, for the "All caught up" line.
 */
export function sessionPreview(
  cards: Flashcard[],
  now: number,
  newLimit: number = NEW_PER_SESSION
): { due: number; fresh: number; nextDue: number | null } {
  const { due, new: fresh } = countStudyable(cards, now);
  const sessionFresh = Math.min(fresh, Math.max(0, newLimit));
  return {
    due,
    fresh: sessionFresh,
    nextDue: due + sessionFresh === 0 ? nextDueAt(cards, now) : null,
  };
}

/** When the next card not yet due comes up, or null when none is scheduled. */
export function nextDueAt(cards: Flashcard[], now: number): number | null {
  let soonest: number | null = null;
  for (const card of cards) {
    if (!card.srs || isDue(card, now)) continue;
    if (soonest === null || card.srs.due < soonest) soonest = card.srs.due;
  }
  return soonest;
}
