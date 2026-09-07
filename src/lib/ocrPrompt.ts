import type { Block, DocumentSection, OcrPage } from './documentModel';
import { applyContext } from './documentModel';
import { parseJsonArray } from './textUtils';

/**
 * Transcribes scanned/photographed PDF pages, the same way cardPrompt.ts's
 * CARD_SYSTEM_PROMPT turns blocks into cards: one prompt, shared between the
 * hosted server route and the bring-your-own-key browser route (both go
 * through src/lib/aiTransport.ts).
 *
 * Deliberately asks for less structure than the full Block union — no table,
 * code or image detection from a photograph, only heading/paragraph/list. See
 * "Non-goals" in docs/superpowers/specs/2026-09-07-pdf-ocr-support-design.md.
 */
export const OCR_SYSTEM_PROMPT = `You are given one or more scanned or photographed pages from a study document, each labeled with the page it came from. Transcribe the readable text of each page faithfully.

Rules:
1. Preserve headings, paragraphs, and bullet lists as separate blocks. Do not summarize or paraphrase — transcribe what is written.
2. Never invent text you cannot read. Skip illegible words, illegible lines, or illegible pages entirely rather than guessing at their content.
3. Ignore page furniture: page numbers, headers/footers, watermarks, scan artifacts.
4. Work through the pages in the order given, one entry per page.

Return ONLY a JSON array, no markdown fence, no commentary. Each element:
{"page": string, "title": string | null, "blocks": [{"type": "heading", "text": string} | {"type": "paragraph", "heading": string | null, "text": string} | {"type": "list", "heading": string | null, "items": string[]}]}

"page" is the page's label, copied exactly from what you were given. A page with nothing legible on it still gets an entry, with an empty "blocks" array.`;

/**
 * Parses a model response into sections, matched back to the real OcrPage by
 * the "page" label it echoed — the same defensive lookup-by-label pattern
 * cardPrompt.ts's parseCardsResponse uses for a card's "source".
 *
 * Tolerates a fenced or truncated reply via parseJsonArray. A page the model
 * never returned an entry for (dropped by truncation, or a "page" value that
 * matches nothing) is simply left out of the result — the caller
 * (ocrGenerator.ts) is what turns "never got a section" into a reported
 * failure, since there is no rule-based fallback for a page with no text.
 */
export function parseOcrResponse(text: string, pages: OcrPage[]): DocumentSection[] {
  const byLabel = new Map(pages.map((p) => [p.label, p]));
  const sections: DocumentSection[] = [];

  for (const raw of parseJsonArray(text)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.page !== 'string') continue;
    const page = byLabel.get(entry.page);
    if (!page) continue;

    const title = typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : undefined;
    const rawBlocks = Array.isArray(entry.blocks) ? entry.blocks : [];
    const blocks: Block[] = [];

    for (const rb of rawBlocks) {
      if (!rb || typeof rb !== 'object') continue;
      const b = rb as Record<string, unknown>;
      const heading = typeof b.heading === 'string' && b.heading.trim() ? b.heading.trim() : undefined;

      if (b.type === 'heading' && typeof b.text === 'string' && b.text.trim()) {
        blocks.push({ kind: 'heading', text: b.text.trim(), level: 2 });
      } else if (b.type === 'paragraph' && typeof b.text === 'string' && b.text.trim()) {
        blocks.push({ kind: 'paragraph', text: b.text.trim(), heading });
      } else if (b.type === 'list' && Array.isArray(b.items)) {
        const items = b.items.filter(
          (i: unknown): i is string => typeof i === 'string' && i.trim().length > 0
        );
        if (items.length > 0) blocks.push({ kind: 'list', items, heading });
      }
    }

    if (title) blocks.unshift({ kind: 'heading', text: title, level: 1 });
    applyContext(blocks, title);

    sections.push({ label: page.label, title, pageNum: page.pageNum, blocks });
  }

  return sections;
}
