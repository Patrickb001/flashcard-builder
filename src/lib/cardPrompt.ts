/**
 * The prompt is shared between the browser (bring-your-own-key mode) and the
 * serverless function (hosted mode) so both paths produce identical cards.
 *
 * The model is deliberately given the STRUCTURED blocks produced by
 * layoutAnalysis, never raw page text. Raw text from a multi-column page has
 * already lost its column boundaries, and a model handed scrambled columns will
 * fluently assert things the document never said.
 */

export const CARD_SYSTEM_PROMPT = `You write flashcards for a student who will study only from the cards, without re-reading the source. You are given structured blocks extracted from one section of a document.

Write cards that satisfy ALL of these:

1. ATOMIC — one fact per card. Split compound statements into separate cards.
2. SELF-CONTAINED — the question must make sense with no other context. Never write "What is important about this?" or refer to "the above", "the following", "this example".
3. REAL QUESTIONS — the front must read as a natural question a tutor would ask, not a label with a question mark appended. Prefer "What are the adult implications of avoidant attachment?" over "Avoidant — Adult Implications?".
4. GROUNDED — use only facts present in the blocks. Never add outside knowledge, never guess, never fill gaps. If a block is navigation, boilerplate, a page header, a code caption, or a table of contents, skip it entirely.
5. ANSWERABLE FROM RECALL — the back should be 1-2 sentences or a short list, under about 50 words. If a passage is too long, split it into several cards rather than pasting it.
6. SPECIFIC TERMS — when the section defines a named concept, always produce a card for that definition.

Also:
- If a fact pairs a name with a range, quantity, or classification (a stage and its age range, a pattern and its prevalence), emit that as its own separate card.
- For tables, emit one card per meaningful cell, phrased using the row and column headers.
- Preserve exact numbers, percentages, and technical identifiers verbatim. Do not round or paraphrase them.
- Skip anything that is not worth memorising. Returning few cards is better than returning filler.

Return ONLY a JSON array, with no markdown fence and no commentary. Each element:
{"front": string, "back": string, "context": string}

"context" is a short topic label (2-5 words) naming what the card is about, used as a chip on the card. Return [] if the section has nothing worth learning.`;

export interface LlmCard {
  front: string;
  back: string;
  context?: string;
}

/** Parses a model response into cards, tolerating a stray markdown fence. */
export function parseCardsResponse(text: string): LlmCard[] {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();

  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (c): c is LlmCard =>
          !!c && typeof c.front === 'string' && typeof c.back === 'string'
      )
      .map((c) => ({
        front: c.front.trim(),
        back: c.back.trim(),
        context: typeof c.context === 'string' ? c.context.trim() : undefined,
      }));
  } catch {
    return [];
  }
}
