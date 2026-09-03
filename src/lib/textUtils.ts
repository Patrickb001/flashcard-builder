/**
 * Small text helpers shared by the card and question pipelines.
 *
 * Nothing here may import anything at runtime: the prompt modules that use it
 * are imported by the server handlers, and a stray reference to the DOM would
 * follow it into the server bundle.
 */

/**
 * A comparable key for a piece of text.
 *
 * Case, punctuation and run-length of whitespace all stop mattering, so
 * "If-else statement", "if else statement" and "IF ELSE  STATEMENT!" collapse
 * to one key. Used wherever two pieces of text need to be recognised as the
 * same thing: two options that say the same, a heading repeated across pages,
 * a card whose front restates its label.
 *
 * The one definition — it is easy to write a fourth by hand, and a key that
 * disagrees with this one silently stops matching things it should.
 */
export function normalizeSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Words too common to say anything about what a card is about.
 *
 * Deliberately short. This is not a linguistic stoplist — it only has to stop
 * two questions looking alike because they both say "what" and "you".
 */
const STOPWORDS = new Set([
  'what', 'when', 'where', 'which', 'that', 'this', 'those', 'these', 'with',
  'from', 'your', 'you', 'the', 'and', 'for', 'not', 'but', 'its', 'into',
  'does', 'doing', 'done', 'should', 'would', 'could', 'about', 'according',
  'them', 'they', 'their', 'instead', 'rather', 'than', 'inside', 'within',
  'without', 'like', 'such', 'also', 'have', 'has', 'are', 'was', 'were',
]);

/**
 * Crude suffix stripping, applied until the word stops changing.
 *
 * Two cards that say "synchronize" and "synchronized" are talking about the
 * same thing, and comparing raw tokens says they are not. Repeated rather than
 * single-pass so "variables" and "variable" reach the same stem instead of one
 * stopping a step short of the other.
 *
 * This is not a real stemmer and does not need to be: it feeds a similarity
 * score whose only job is to decide whether two cards are near-duplicates.
 */
function stem(word: string): string {
  let s = word;
  for (;;) {
    let next = s;
    for (const suffix of ['ing', 'ed', 'es', 's', 'e']) {
      if (s.endsWith(suffix) && s.length - suffix.length >= 4) {
        next = s.slice(0, -suffix.length);
        break;
      }
    }
    if (next === s) return s;
    s = next;
  }
}

/** The words in a piece of text that carry its meaning, stemmed. */
export function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      // Anything with a digit is kept whatever its length. Dropping short
      // tokens is right for words and catastrophic for numbers: "4 days" and
      // "7 days" both reduce to "days", and two cards giving different
      // durations, doses or thresholds would score as identical — exactly the
      // cards where being wrong matters most.
      .filter((w) => (w.length >= 4 || /\d/.test(w)) && !STOPWORDS.has(w))
      .map((w) => (/\d/.test(w) ? w : stem(w)))
  );
}

/**
 * The string-taking form of `wordOverlap`, tokenizing both sides first.
 *
 * Kept for the dedupe test harness (`tools/test-dedupe.mjs`), which compares raw
 * card text. App code holds word sets already and should call `wordOverlap`.
 */
export function overlapRatio(a: string, b: string): number {
  return wordOverlap(contentWords(a), contentWords(b));
}

/**
 * How much of the shorter word set is contained in the longer, from 0 to 1.
 *
 * The overlap coefficient rather than Jaccard: dividing by the union punishes a
 * short text for being short, and the same question asked at two lengths is a
 * duplicate. A very short text is correspondingly likely to be wholly contained
 * in anything, so callers must require a minimum size before trusting a high
 * score.
 *
 * Takes sets rather than strings because de-duplication is quadratic in the
 * cards it keeps — see "The overlap measure" in docs/tuning-notes.md.
 */
export function wordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const word of small) if (large.has(word)) shared++;
  return shared / small.size;
}

/**
 * True when two texts both quote numbers and the numbers disagree.
 *
 * The one case where high word overlap is the strongest possible evidence that
 * two things are NOT the same. "4 days, with observable change in functioning"
 * and "7 days, with observable change in functioning" share four words in five
 * and are the two halves of a distinction a student is being examined on;
 * merging them would delete one side of it and leave no trace. The same holds
 * for a therapeutic range against a toxic one, or two prevalence figures.
 *
 * Only decisive when both sides quote numbers. One card giving a figure and
 * another not is ordinary — a definition beside a value — and says nothing.
 */
export function hasConflictingNumbers(a: string, b: string): boolean {
  const numbers = (text: string) =>
    new Set(text.match(/\d+(?:\.\d+)?/g) ?? []);

  const first = numbers(a);
  const second = numbers(b);
  if (first.size === 0 || second.size === 0) return false;

  for (const number of first) if (!second.has(number)) return true;
  for (const number of second) if (!first.has(number)) return true;
  return false;
}

/**
 * Strips a markdown fence a model wrapped its JSON in.
 *
 * Both prompts ask for bare JSON and both sometimes get it fenced anyway, so
 * both had to undo it; this is that undoing, once.
 */
export function stripJsonFence(text: string): string {
  return text
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

/**
 * Pulls the complete objects out of a response whose array never closed.
 *
 * Both prompts ask for a JSON array and both can be cut off by the token
 * ceiling. Parsing the array as a whole turns that into the loss of every item
 * in the batch, when all but the last are intact. Scanning for balanced braces
 * recovers them.
 *
 * String contents are tracked so a brace inside a value cannot end an object
 * early.
 *
 * This lived in quizPrompt, where a truncated reply was found first. Cards hit
 * exactly the same wall on a dense document — a lecture page that asks for
 * fifty cards overruns the ceiling the same way a batch of quiz questions does
 * — and the card parser's own "no closing bracket, return nothing" guard threw
 * away whole pages that had arrived almost complete.
 */
export function salvageObjects(text: string): unknown[] {
  const found: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          found.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // A malformed object among well-formed ones; the rest still stand.
        }
        start = -1;
      }
    }
  }

  return found;
}
