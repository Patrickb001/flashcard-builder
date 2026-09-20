import {
  DAY_MS,
  DEFAULT_EASE,
  MAX_INTERVAL_DAYS,
  MIN_EASE,
  applyGrade,
  countsAsReview,
  describeDue,
  describeSchedule,
  isDue,
  nextSchedule,
  scheduleState,
  startOfNextDay,
} from '../src/lib/scheduling.ts';
import {
  buildQueue,
  countStudyable,
  nextDueAt,
  parseStudyMode,
  requeue,
  sessionPreview,
} from '../src/lib/studyQueue.ts';

/**
 * Spaced-repetition scheduling and study-session queues.
 *
 *   node --experimental-strip-types --import ./tools/register.mjs tools/test-scheduling.mjs
 *
 * Pure — no browser, no IndexedDB, no model call. Every date is built with the
 * local-time Date constructor in January, so the day-boundary checks hold in
 * any timezone and no daylight-saving change falls inside a test.
 */

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`}`
  );
}

const at = (day, hour = 9) => new Date(2026, 0, day, hour, 0, 0, 0).getTime();
const NOW = at(10);

function card(id, srs) {
  return {
    id,
    deckId: 'd',
    front: `Q ${id}`,
    back: `A ${id}`,
    sourceLabel: 'Page 1',
    status: 'new',
    createdAt: 0,
    ...(srs ? { srs } : {}),
  };
}

/** A learned card with a given interval, due at `due`. */
function learned(id, due, intervalDays = 3, ease = DEFAULT_EASE) {
  return card(id, { due, intervalDays, ease, reps: 2, lapses: 0, lastReviewedAt: due - intervalDays * DAY_MS });
}

// ---------------------------------------------------------------------------
console.log('DAY BOUNDARY');
// ---------------------------------------------------------------------------

check('the next day starts at local midnight', startOfNextDay(at(10, 9)), at(11, 0));
check('a card due tonight is due this morning', isDue(learned('a', at(10, 21)), at(10, 8)), true);
check('a card due tomorrow morning is not due tonight', isDue(learned('a', at(11, 6)), at(10, 23)), false);
check('a new card is never "due"', isDue(card('a'), NOW), false);

// ---------------------------------------------------------------------------
console.log('\nNEXT SCHEDULE');
// ---------------------------------------------------------------------------

const firstGood = nextSchedule(undefined, 'good', NOW);
check('a new card graded good comes back in a day', firstGood.intervalDays, 1);
check('... is due one day later', firstGood.due, NOW + DAY_MS);
check('... starts at the default ease', firstGood.ease, DEFAULT_EASE);
check('... counts one rep', firstGood.reps, 1);
check('a new card graded easy comes back in four days', nextSchedule(undefined, 'easy', NOW).intervalDays, 4);
check('a new card graded hard comes back in a day', nextSchedule(undefined, 'hard', NOW).intervalDays, 1);

const firstAgain = nextSchedule(undefined, 'again', NOW);
check('a new card graded again is due now', firstAgain.due, NOW);
check('... is not counted as a lapse', firstAgain.lapses, 0);
check('... keeps the default ease', firstAgain.ease, DEFAULT_EASE);

// A card reviewed good on time, repeatedly: 1, 3, 8, 20 days (ease 2.5, rounded).
let s = firstGood;
const intervals = [s.intervalDays];
for (let i = 0; i < 3; i++) {
  s = nextSchedule(s, 'good', s.due);
  intervals.push(s.intervalDays);
}
check('good on time grows the interval by the ease', intervals, [1, 3, 8, 20]);

const review = { due: NOW, intervalDays: 10, ease: 2.5, reps: 3, lapses: 0, lastReviewedAt: NOW - 10 * DAY_MS };
check('hard grows the interval by 1.2', nextSchedule(review, 'hard', NOW).intervalDays, 12);
check('hard lowers the ease', nextSchedule(review, 'hard', NOW).ease, 2.35);
check('easy grows the interval faster than good', nextSchedule(review, 'easy', NOW).intervalDays, 34);
check('easy raises the ease', nextSchedule(review, 'easy', NOW).ease, 2.65);

const lapse = nextSchedule(review, 'again', NOW);
check('forgetting a learned card is a lapse', lapse.lapses, 1);
check('... cuts the ease by 0.2', lapse.ease, 2.3);
check('... resets reps', lapse.reps, 0);
check('... is due now', lapse.due, NOW);
const lapseAgain = nextSchedule(lapse, 'again', NOW + 60_000);
check('failing it again while relearning is not a second lapse', lapseAgain.lapses, 1);
check('... and does not cut the ease again', lapseAgain.ease, 2.3);
check('relearned with good, it comes back in a day', nextSchedule(lapse, 'good', NOW).intervalDays, 1);

const floor = { ...review, ease: MIN_EASE };
check('the ease never drops below the minimum', nextSchedule(floor, 'again', NOW).ease, MIN_EASE);
check('hard on a minimum-ease card still grows by at least a day', nextSchedule({ ...floor, intervalDays: 1 }, 'hard', NOW).intervalDays, 2);
check(
  'the interval is capped at a year',
  nextSchedule({ ...review, intervalDays: 300 }, 'easy', NOW).intervalDays,
  MAX_INTERVAL_DAYS
);

// ---------------------------------------------------------------------------
console.log('\nWHICH GRADES COUNT');
// ---------------------------------------------------------------------------

const notYetDue = learned('early', at(20));
check('forgetting counts even before a card is due', countsAsReview(notYetDue, 'again', NOW), true);
check('remembering early does not count', countsAsReview(notYetDue, 'good', NOW), false);
check('remembering a due card counts', countsAsReview(learned('due', at(10, 6)), 'good', NOW), true);
check('remembering a new card counts', countsAsReview(card('n'), 'good', NOW), true);

check('an early success returns the very same card', applyGrade(notYetDue, 'good', NOW) === notYetDue, true);
const graded = applyGrade(card('n'), 'good', NOW);
check('grading a new card schedules it', graded.srs?.intervalDays, 1);
check('... and marks it known', graded.status, 'known');
check('grading again marks it unknown', applyGrade(card('n'), 'again', NOW).status, 'unknown');

// ---------------------------------------------------------------------------
console.log('\nLABELS');
// ---------------------------------------------------------------------------

check('state of a new card', scheduleState(card('n'), NOW), 'new');
check('state of a due card', scheduleState(learned('d', at(10, 6)), NOW), 'due');
check('state of a later card', scheduleState(learned('l', at(14)), NOW), 'scheduled');
check('due later today reads as today', describeDue(at(10, 22), NOW), 'today');
check('due at 1am tomorrow reads as tomorrow', describeDue(at(11, 1), at(10, 23)), 'tomorrow');
check('four days out', describeDue(at(14), NOW), 'in 4 days');
check('about two months out', describeDue(NOW + 62 * DAY_MS, NOW), 'in 2 months');
check('manager label for a new card', describeSchedule(card('n'), NOW), 'New');
check('manager label for a due card', describeSchedule(learned('d', at(10, 6)), NOW), 'Due');
check('manager label for a later card', describeSchedule(learned('l', at(14)), NOW), 'Due in 4 days');

// ---------------------------------------------------------------------------
console.log('\nSESSION QUEUE');
// ---------------------------------------------------------------------------

const identity = (items) => [...items];
const deck = [
  card('n1'),
  learned('due1', at(9)),
  card('n2'),
  learned('later', at(15)),
  learned('due2', at(10, 20)),
  card('n3'),
];
check(
  'review: due cards first, then new cards in deck order',
  buildQueue(deck, 'review', NOW, { shuffle: identity }),
  ['due1', 'due2', 'n1', 'n2', 'n3']
);
check(
  'review: new cards are limited per session',
  buildQueue(deck, 'review', NOW, { shuffle: identity, newLimit: 2 }),
  ['due1', 'due2', 'n1', 'n2']
);
check('review: a card not yet due is left out', buildQueue(deck, 'review', NOW).includes('later'), false);
check('all: every card, in deck order', buildQueue(deck, 'all', NOW), ['n1', 'due1', 'n2', 'later', 'due2', 'n3']);
check('an empty deck has an empty queue', buildQueue([], 'review', NOW), []);

check('a miss comes back three cards later', requeue(['a', 'b', 'c', 'd', 'e', 'f'], 0, 'a'), ['a', 'b', 'c', 'd', 'a', 'e', 'f']);
check('a miss near the end goes to the end', requeue(['a', 'b', 'c'], 1, 'b'), ['a', 'b', 'c', 'b']);
check('a miss on the last card comes straight back', requeue(['a'], 0, 'a'), ['a', 'a']);

check('counts due and new', countStudyable(deck, NOW), { due: 2, new: 3 });
check('a session holds every due card and the new ones', sessionPreview(deck, NOW), { due: 2, fresh: 3, nextDue: null });
check('... new cards up to the session limit', sessionPreview(deck, NOW, 2), { due: 2, fresh: 2, nextDue: null });
check(
  'a session matches the queue it would build',
  (() => {
    const p = sessionPreview(deck, NOW, 2);
    return p.due + p.fresh;
  })(),
  buildQueue(deck, 'review', NOW, { newLimit: 2 }).length
);
check('an empty session says when the next review is', sessionPreview([learned('later', at(15))], NOW), { due: 0, fresh: 0, nextDue: at(15) });
check('a deck with nothing scheduled has no next review', sessionPreview([], NOW), { due: 0, fresh: 0, nextDue: null });
check('the next card coming up', nextDueAt(deck, NOW), at(15));
check('nothing scheduled means no next date', nextDueAt([card('n')], NOW), null);
check('?mode=all is cram mode', parseStudyMode('all'), 'all');
check('no mode is a review session', parseStudyMode(null), 'review');
check('an unknown mode is a review session', parseStudyMode('bogus'), 'review');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
