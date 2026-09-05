/**
 * Writes a deck out as one line of delimited text.
 *
 * The shape — `front&back;front&back;` — is what the flashcard importers ask
 * for: a field separator, a record separator, nothing else. There is no quoting
 * layer, so the two delimiters are the only structure the file has, and a card
 * that contains one of them would silently become an extra field or an extra
 * card. `sanitizeField` is the whole defence.
 */

import type { Flashcard } from '../types';
import { normalizeSlug } from './textUtils';

/** The field and record separators, and what a card's own copy of one becomes. */
const DELIMITER_SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/&/g, 'and'],
  [/;/g, ','],
];

/**
 * Makes one card face safe to write between the delimiters.
 *
 * Deliberately narrow: only the two structural characters are touched. Quotes
 * and line breaks the user typed survive the round trip unchanged, which keeps
 * the export honest about what the card says.
 */
function sanitizeField(text: string): string {
  return DELIMITER_SUBSTITUTIONS.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    text,
  );
}

/**
 * The whole deck as a single line, with a trailing `;` closing the last card.
 *
 * Only the two text faces travel. A card's code snippet or image cannot survive
 * a text file, so they are dropped rather than flattened into something that
 * reads like the card's own words.
 */
export function formatDeckForExport(cards: Flashcard[]): string {
  if (cards.length === 0) return '';
  return cards.map((card) => `${sanitizeField(card.front)}&${sanitizeField(card.back)}`).join(";") + ";";
}

/** A deck name as a filename: "Biology Ch. 3" becomes "biology-ch-3.txt". */
export function exportFileName(deckName: string): string {
  const slug = normalizeSlug(deckName).replace(/ /g, '-');
  return `${slug || 'deck'}.txt`;
}

/** Hands the browser a text file to save. Client-only; nothing server-side imports this. */
export function downloadTextFile(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
