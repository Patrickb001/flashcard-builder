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
