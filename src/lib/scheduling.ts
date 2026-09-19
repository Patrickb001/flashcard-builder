import type { CardSchedule, Flashcard } from '../types';

/**
 * Spaced repetition: when a card should next come up, given how it just went.
 *
 * A trimmed SM-2 — the algorithm Anki grew from — because it is small enough to
 * read in one sitting and its behaviour is easy to predict from the numbers
 * below. Pure, with `now` always passed in, so tools/test-scheduling.mjs can
 * walk a card through months of reviews without waiting for any of them.
 *
 * The UI offers two buttons today ("Still learning" is `again`, "Knew it" is
 * `good`). `hard` and `easy` are implemented and tested so that a four-button
 * grading row is a UI-only change later.
 */

export type Grade = 'again' | 'hard' | 'good' | 'easy';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_EASE = 2.5;
export const MIN_EASE = 1.3;
/** A year. Past this the schedule stops meaning much for course material. */
export const MAX_INTERVAL_DAYS = 365;

/** First intervals, in days, for a card that is new or relearning. */
const FIRST_INTERVAL: Record<Exclude<Grade, 'again'>, number> = { hard: 1, good: 1, easy: 4 };

/**
 * The start of the local day after `now`.
 *
 * Due-ness is judged against this rather than against `now`, so a card due at
 * 9pm counts as due to someone studying at 8am the same day. Without it a
 * one-day interval set at night would skip the next morning's session.
 * setHours(24) rather than adding DAY_MS, so a daylight-saving change cannot
 * move the boundary off midnight.
 */
export function startOfNextDay(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** Never graded. Every card saved before scheduling existed is new. */
export function isNew(card: Pick<Flashcard, 'srs'>): boolean {
  return card.srs === undefined;
}

/** Graded before, and its next review falls today or earlier. */
export function isDue(card: Pick<Flashcard, 'srs'>, now: number): boolean {
  return card.srs !== undefined && card.srs.due < startOfNextDay(now);
}

/** The next schedule for a card, given a grade. The core of the algorithm. */
export function nextSchedule(prev: CardSchedule | undefined, grade: Grade, now: number): CardSchedule {
  const base: CardSchedule = prev ?? {
    due: now,
    intervalDays: 0,
    ease: DEFAULT_EASE,
    reps: 0,
    lapses: 0,
    lastReviewedAt: now,
  };
  const learning = base.reps === 0;

  if (grade === 'again') {
    // Only forgetting a LEARNED card is a lapse. Failing a card that is still
    // being learned — or failing it twice in one day, say in study and then in
    // a test — must not keep cutting its ease, or one bad afternoon would pin a
    // card at the minimum for good.
    return {
      due: now,
      intervalDays: 0,
      ease: learning ? base.ease : Math.max(MIN_EASE, base.ease - 0.2),
      reps: 0,
      lapses: learning ? base.lapses : base.lapses + 1,
      lastReviewedAt: now,
    };
  }

  let intervalDays: number;
  let ease = base.ease;
  if (learning) {
    intervalDays = FIRST_INTERVAL[grade];
  } else {
    const prevInterval = Math.max(1, base.intervalDays);
    if (grade === 'hard') {
      ease = Math.max(MIN_EASE, ease - 0.15);
      intervalDays = prevInterval * 1.2;
    } else if (grade === 'good') {
      intervalDays = prevInterval * ease;
    } else {
      ease += 0.15;
      intervalDays = prevInterval * ease * 1.3;
    }
    // Always at least a day longer than last time: a success that schedules
    // the card sooner than before reads as a punishment.
    intervalDays = Math.max(prevInterval + 1, Math.round(intervalDays));
  }
  intervalDays = Math.min(MAX_INTERVAL_DAYS, intervalDays);

  return {
    due: now + intervalDays * DAY_MS,
    intervalDays,
    ease,
    reps: base.reps + 1,
    lapses: base.lapses,
    lastReviewedAt: now,
  };
}

/**
 * Whether a grade should move the card's schedule at all.
 *
 * Forgetting always counts. Remembering counts only when the card was actually
 * up for review — new, or due. A card answered correctly days before it was
 * due (cramming the whole deck, or a lucky multiple-choice answer) would
 * otherwise have its interval multiplied as if it had survived the full gap,
 * which is exactly the evidence spacing is supposed to collect.
 */
export function countsAsReview(card: Pick<Flashcard, 'srs'>, grade: Grade, now: number): boolean {
  return grade === 'again' || isNew(card) || isDue(card, now);
}

/**
 * The card after a grade, or the same object when the grade does not count.
 *
 * The one place a schedule is written. The legacy `status` is kept in step so
 * older records and anything still reading it stay truthful. Callers compare
 * the result by identity to learn whether anything needs saving.
 */
export function applyGrade(card: Flashcard, grade: Grade, now: number): Flashcard {
  if (!countsAsReview(card, grade, now)) return card;
  return {
    ...card,
    srs: nextSchedule(card.srs, grade, now),
    status: grade === 'again' ? 'unknown' : 'known',
  };
}

/** A card's place in the schedule, for labels and colour. */
export type ScheduleState = 'new' | 'due' | 'scheduled';

export function scheduleState(card: Pick<Flashcard, 'srs'>, now: number): ScheduleState {
  if (isNew(card)) return 'new';
  return isDue(card, now) ? 'due' : 'scheduled';
}

/**
 * How long until `due`, in words, counted in calendar days.
 *
 * Calendar days rather than elapsed hours, so "tomorrow" means tomorrow even
 * when it is less than 24 hours away.
 */
export function describeDue(due: number, now: number): string {
  const today = startOfNextDay(now) - DAY_MS;
  const days = Math.round((startOfNextDay(due) - DAY_MS - today) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 31) return `in ${days} days`;
  const months = Math.round(days / 30);
  return months <= 1 ? 'in a month' : `in ${months} months`;
}

/** The deck manager's label for a card: "New", "Due", or "Due in 4 days". */
export function describeSchedule(card: Pick<Flashcard, 'srs'>, now: number): string {
  const state = scheduleState(card, now);
  if (state === 'new') return 'New';
  if (state === 'due') return 'Due';
  return `Due ${describeDue(card.srs!.due, now)}`;
}
