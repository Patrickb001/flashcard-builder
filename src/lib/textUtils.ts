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
 * This existed three times over, byte for byte, under three different names.
 */
export function normalizeSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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
