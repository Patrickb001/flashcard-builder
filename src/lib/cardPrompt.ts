/**
 * The prompt is shared between the browser (bring-your-own-key mode) and the
 * serverless function (hosted mode) so both paths produce identical cards.
 *
 * The model is deliberately given the STRUCTURED blocks produced by
 * layoutAnalysis, never raw page text. Raw text from a multi-column page has
 * already lost its column boundaries, and a model handed scrambled columns will
 * fluently assert things the document never said.
 *
 * Snippets and diagrams are handed over the same way: as blocks carrying an id.
 * The model attaches one to a card by naming its id, never by reproducing it.
 * Asking a model to retype a program is asking it to introduce a typo into the
 * one part of a card that has to be exact, and an image cannot be retyped at
 * all — a model asked for a picture's address will invent a plausible one.
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

ATTACHING CODE AND DIAGRAMS

Code blocks arrive as {"type":"code","id":"c1","language":...,"label":...,"text":...,"output":...,"alsoIn":[...]}. Image blocks arrive as {"type":"image","id":"i1","alt":...,"caption":...,"label":...}.

Attach one to a card by naming its id in "frontCode", "backCode", or "image". NEVER copy a snippet into the front or back text, and never write an id that was not given to you.

- "frontCode" puts the snippet in the question. Use it whenever the question is ABOUT a particular program: what it prints, what it does, what is wrong with it. A question that refers to an example the student cannot see is not self-contained, so any question mentioning a specific snippet must carry that snippet on the front.
- "backCode" puts the snippet in the answer. Use it when the question asks the student to recall syntax or an idiom, and the snippet is what they should have written.
- "image" puts the diagram on the answer side.

Cards worth making from a snippet:
- When it has "output": ask what the program prints, with "frontCode" set to its id and the exact output as the back.
- When it shows how something is written: ask how the task is done, with "backCode" set to its id and a one-line explanation as the back text.
- A snippet that is only an import, or boilerplate setup, is not worth a card at all.

Cards worth making from a diagram: when a section carries an image block, make one card for it unless the picture is plainly decorative. A flowchart, a structure diagram or a labelled illustration is worth recalling in its own right. Ask what the diagram shows — "What does the flow of an if-else statement look like?" — put a one-sentence description of it in the back text, taken from the prose around it, and set "image" to its id. Note that "alt" is often just a file name and tells you nothing; work out what the picture shows from "label" and the text around the block.

"alsoIn" lists other languages the same program was published in. The idea is not specific to the language shown, so do not write a question implying it is — unless the section is itself about that language.

Every card still needs front and back text that stand on their own: the attachment supports the text, it never replaces it. A back of "see the code" is not an answer.

Return ONLY a JSON array, with no markdown fence and no commentary. Each element:
{"front": string, "back": string, "context": string, "frontCode": string?, "backCode": string?, "image": string?}

"context" is a short topic label (2-5 words) naming what the card is about, used as a chip on the card. Return [] if the section has nothing worth learning.`;

export interface LlmCard {
  front: string;
  back: string;
  context?: string;
  /** Ids of blocks from the payload; resolved to real content by the caller. */
  frontCode?: string;
  backCode?: string;
  image?: string;
}

/** An id the model may have written, or undefined when it wrote something else. */
function assetRef(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
        frontCode: assetRef(c.frontCode),
        backCode: assetRef(c.backCode),
        image: assetRef(c.image),
      }));
  } catch {
    return [];
  }
}
