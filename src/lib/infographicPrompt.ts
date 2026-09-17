import { stripJsonFence } from './textUtils';
import type { InfographicDetail } from '../types';

/**
 * The infographic pipeline: an extraction call (a deck's flashcards in,
 * structured JSON out) followed by a design call (that JSON in, one
 * self-contained HTML document out). Shared between the browser
 * (bring-your-own-key mode) and the serverless function, exactly as the
 * card and quiz prompts are. This module must import nothing at runtime
 * beyond other such modules — the Netlify function imports it, and a stray
 * reference to the DOM or to localStorage would follow it into the server
 * bundle. The design call's HTML sanitizer lives apart from this file
 * (infographicSanitize.ts) for exactly that reason — it needs a DOM
 * implementation (linkedom) that this module has no reason to carry.
 */

// ---------------------------------------------------------------------------
// Stage 1: extraction
// ---------------------------------------------------------------------------

export interface ExtractedInfographicItem {
  label: string;
  detail: string;
  meta?: string;
}

export interface ExtractedInfographicComparison {
  name: string;
  value: string;
}

/** What the extraction call returns, and what the design call is given as its whole input. */
export interface ExtractedInfographicContent {
  title: string;
  lede: string;
  /** The single biggest idea, as 2-4 short pairs. Absent when nothing in the material forms one. */
  coreConcept?: Record<string, string>;
  items: ExtractedInfographicItem[];
  /** Present only when the material has 2+ things worth weighing on shared criteria. */
  comparisons?: ExtractedInfographicComparison[];
  keyTakeaway: string;
}

/** Per-level target guidance, folded into each level's own prompt text below. */
const ITEM_TARGET: Record<InfographicDetail, string> = {
  basic: '4-5 items',
  standard: '6-8 items',
  detailed: '8-10 items',
};

/** Parse-time ceilings — a wider safety net than the target above, clamped rather than rejected. */
const ITEM_CEILING: Record<InfographicDetail, number> = { basic: 6, standard: 9, detailed: 12 };
const CORE_CONCEPT_CEILING = 4;
const COMPARISONS_CEILING = 6;

function buildExtractionPrompt(detail: InfographicDetail): string {
  return `You extract the key teachable content from a set of flashcards, so it can be redesigned as a visual infographic in a later step. You are given some flashcards from one deck (front, back, and sometimes a topic).

Do not summarize in prose. Reply with ONLY a JSON object, no prose before or after, shaped exactly like this:

{
  "title": "A short title for the whole infographic",
  "lede": "One sentence, under 25 words, framing what this covers",
  "coreConcept": { "A short label": "a short value", "...": "..." },
  "items": [
    { "label": "A short name", "detail": "One sentence explaining it", "meta": "optional short tag" }
  ],
  "comparisons": [ { "name": "A short name", "value": "What it is on this criterion" } ],
  "keyTakeaway": "One sentence: the single thing to remember"
}

Write ${ITEM_TARGET[detail]} — aim for that range, but it is a guide, not a hard limit; write what the cards actually support.

Rules:
1. GROUNDED — use only facts present in the flashcards. Never add outside knowledge, never invent data, numbers, or examples.
2. SYNTHESIZE, DON'T TRANSCRIBE — an item should read as a distilled idea, not a card's back pasted in verbatim.
3. "coreConcept" is the single biggest idea the material has, as 2-4 short key/value pairs. Omit the field entirely (do not send an empty object) if nothing in the cards forms one central idea.
4. "comparisons" only applies when the cards describe 2 or more things being weighed on the same criteria. Omit the field entirely otherwise.
5. "meta" on an item is optional — a short tag like a number, a category, or a time label. Omit it when nothing short like that applies; never pad it with a made-up value.
6. Keep every string short — this feeds a glance-able visual, not a document. Concretely: names and labels under 80 characters, item details and comparison values under 240, the lede and the takeaway under 240. Write within those rather than relying on being trimmed to them — anything over is cut, and a cut sentence reaches the reader looking broken.`;
}

/** One prompt per detail level — the level controls how much content the extraction call asks for. */
export const INFOGRAPHIC_EXTRACT_PROMPTS: Record<InfographicDetail, string> = {
  basic: buildExtractionPrompt('basic'),
  standard: buildExtractionPrompt('standard'),
  detailed: buildExtractionPrompt('detailed'),
};

/**
 * Character budgets per field — runaway protection, NOT routine editing.
 *
 * These are deliberately well clear of what the model actually writes. A
 * `comparison.value` budget of 60 used to sit right in the middle of that
 * field's natural output (the model writes 50-60 characters for it), so the
 * clamp fired on ordinary replies and every table cell in the finished
 * infographic ended mid-word: "...via address calculati…". The text was gone
 * before the design call ever ran, so nothing downstream could offer to
 * expand it.
 *
 * Kept as one table rather than numbers inline at each call site, because a
 * single badly-calibrated value hiding among the arguments is exactly how
 * that happened. If a budget here starts firing on ordinary content, it is
 * the budget that is wrong.
 */
const LIMITS = {
  title: 80,
  lede: 240,
  keyTakeaway: 240,
  itemLabel: 80,
  itemDetail: 240,
  itemMeta: 40,
  comparisonName: 80,
  comparisonValue: 240,
  coreConceptKey: 60,
  coreConceptValue: 160,
} as const;

/**
 * Trims and clamps to `max` chars with a trailing ellipsis; null if nothing
 * survives.
 *
 * Cuts at the last word boundary inside the budget, so a clamp that does fire
 * reads as "…via address…" rather than "…via address calculati…". A single
 * token longer than most of the budget has no boundary to cut at and falls
 * back to a hard cut, which is still better than returning a stub.
 */
function clampText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= max) return trimmed;

  const cut = trimmed.slice(0, max);
  const lastBoundary = cut.lastIndexOf(' ');
  const kept = lastBoundary > max * 0.6 ? cut.slice(0, lastBoundary) : cut;
  return `${kept.trimEnd()}…`;
}

function validateItem(raw: unknown): ExtractedInfographicItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const label = clampText(item.label, LIMITS.itemLabel);
  const detail = clampText(item.detail, LIMITS.itemDetail);
  if (!label || !detail) return null;
  const meta = clampText(item.meta, LIMITS.itemMeta);
  return meta ? { label, detail, meta } : { label, detail };
}

function validateComparison(raw: unknown): ExtractedInfographicComparison | null {
  if (!raw || typeof raw !== 'object') return null;
  const comparison = raw as Record<string, unknown>;
  const name = clampText(comparison.name, LIMITS.comparisonName);
  const value = clampText(comparison.value, LIMITS.comparisonValue);
  if (!name || !value) return null;
  return { name, value };
}

function validateCoreConcept(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>)
    .map((entry): [string, string] | null => {
      const key = clampText(entry[0], LIMITS.coreConceptKey);
      const value = clampText(entry[1], LIMITS.coreConceptValue);
      return key && value ? [key, value] : null;
    })
    .filter((entry): entry is [string, string] => entry !== null)
    .slice(0, CORE_CONCEPT_CEILING);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Reads the model's reply as one JSON object, tolerating a markdown fence,
 * then validates and clamps each field. Clamps rather than rejects a single
 * item, so one malformed item among several good ones doesn't throw the
 * whole reply away.
 *
 * Returns null only when nothing usable could be read at all: the reply
 * isn't a JSON object, or it parses but zero items survive — items are the
 * substantive content the design call is built around, so a reply with none
 * has nothing worth designing a page from.
 */
export function parseExtractionResponse(
  text: string,
  deckName: string,
  detail: InfographicDetail
): ExtractedInfographicContent | null {
  const cleaned = stripJsonFence(text);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const raw = parsed as Record<string, unknown>;

  const items = Array.isArray(raw.items)
    ? raw.items
        .map(validateItem)
        .filter((item): item is ExtractedInfographicItem => item !== null)
        .slice(0, ITEM_CEILING[detail])
    : [];
  if (items.length === 0) return null;

  const title = clampText(raw.title, LIMITS.title) ?? deckName;
  const lede = clampText(raw.lede, LIMITS.lede) ?? '';
  const keyTakeaway = clampText(raw.keyTakeaway, LIMITS.keyTakeaway) ?? '';
  const coreConcept = validateCoreConcept(raw.coreConcept);
  const comparisons = Array.isArray(raw.comparisons)
    ? raw.comparisons
        .map(validateComparison)
        .filter((c): c is ExtractedInfographicComparison => c !== null)
        .slice(0, COMPARISONS_CEILING)
    : undefined;

  return {
    title,
    lede,
    ...(coreConcept ? { coreConcept } : {}),
    items,
    ...(comparisons && comparisons.length > 0 ? { comparisons } : {}),
    keyTakeaway,
  };
}

// ---------------------------------------------------------------------------
// Stage 2: design
// ---------------------------------------------------------------------------

/**
 * The design call's system prompt. Unlike extraction, this is not split by
 * detail level — it's the same layout/color/typography instructions
 * regardless of how much content it's handed; the extraction call already
 * did the level-scaling.
 *
 * The color tokens below are copied by hand from this app's src/index.css
 * (:root and :root[data-theme="dark"]) — see the Global Constraints note in
 * this feature's plan for why they can't be imported instead.
 */
export const INFOGRAPHIC_DESIGN_PROMPT = `Design an educational infographic as ONE self-contained HTML document with inline SVG diagrams, from the structured content you're given. The document must be static: no external images, no JavaScript of any kind — no <script>, no inline event-handler attributes (onclick, onload, etc.), no javascript: links. The ONLY external resource permitted is the Google Fonts <link> described under TYPE below; all other CSS must be inline in a <style> block. Set <html lang="..."> to the actual language of the content you were given — default to "en" only if that content is itself in English.

The user message is a JSON array holding exactly one object: the extracted content. Its fields:
- title: the infographic's title
- lede: a one-sentence framing line
- coreConcept (optional): 2-4 key/value pairs describing the single biggest idea, if there is one
- items: the main entries — each has a "label", a "detail" sentence, and an optional short "meta" tag
- comparisons (optional): pairs of { name, value } worth setting side by side
- keyTakeaway: the one sentence to leave the reader with

Use only what's in that object. Never invent facts, numbers, or examples beyond it.

LAYOUT — pick ONE pattern that matches the content's actual shape, and commit to it:
- If "items" reads as an ordered sequence or process → a horizontal or vertical chain/timeline diagram, boxes connected by SVG arrows.
- If "comparisons" is present, or "items" splits naturally into two groups being weighed against each other → side-by-side comparison cards, or a data table for more than a few rows.
- If "items" are parts of one whole → an "anatomy" diagram: one labeled structure broken into its fields, with pointer lines to each item.
- If "items" are a flat set of categories or facts with no inherent order → a hub-and-spoke diagram, or a clean grid of cards.
Do not default to generic hero-plus-cards if the content doesn't call for it.

COLOR — Use exactly these CSS variables on :root (this app's own palette, so the page matches it), and this exact dark override:

:root {
  --bg:#fafafa; --surface:#ffffff; --surface-raised:#f4f4f5;
  --border-soft:#e4e4e7; --border-strong:#d4d4d8;
  --text-primary:#18181b; --text-secondary:#71717a; --text-faint:#a1a1aa;
  --accent:#5b52d6; --accent-soft:rgba(91,82,214,0.08); --accent-contrast:#ffffff;
  --success:#1a8f5e; --success-soft:rgba(26,143,94,0.08);
  --warning:#b6650a; --warning-soft:rgba(182,101,10,0.08);
  --danger:#c0392b; --danger-soft:rgba(192,57,43,0.08);
  color-scheme: light;
}
:root[data-theme="dark"] {
  --bg:#0a0a0c; --surface:#18181b; --surface-raised:#212126;
  --border-soft:#2a2a30; --border-strong:#3f3f46;
  --text-primary:#f4f4f5; --text-secondary:#a1a1aa; --text-faint:#71717a;
  --accent:#8b87f0; --accent-soft:rgba(139,135,240,0.16); --accent-contrast:#0a0a0c;
  --success:#6bc79b; --success-soft:rgba(107,199,155,0.14);
  --warning:#e0a458; --warning-soft:rgba(224,164,88,0.14);
  --danger:#f2897c; --danger-soft:rgba(242,137,124,0.16);
  color-scheme: dark;
}

Copy those two blocks into the document verbatim (the app sets data-theme on the page itself; do not add a prefers-color-scheme media query, it would fight with that). Build every rule on top of var(--bg), var(--surface), var(--text-primary), etc. — never a hardcoded hex outside these two blocks. --accent is this app's one brand color; --success/--warning/--danger already carry the right hue for "good/caution/bad" semantics if the content needs them. Only if the content has some OTHER binary or ordinal property that doesn't map to good/caution/bad (e.g. two named categories, "before" vs "after") may you add ONE extra pair of your own hex values (a light one and a matching dark one) for that specific encoding — never more than one pair, and never in place of the tokens above.

TYPE — exactly two Google Font families for text, loaded via <link>, with real fallback stacks: one distinctive display/heading face with some personality (not Inter/Roboto/Arial — this app's own UI already uses Inter, so the infographic should read as a distinct designed page, not another app screen), and one clean body face. A third, monospace family may be added ON TOP of those two, but only when the content has genuinely code-like or numeric-table tokens to set in it; if it does not, load only the two.

SVG — every diagram uses viewBox (never fixed pixel width/height) so it scales with its container. Give each <svg> diagram a <title> element naming what it shows, for screen readers. Keep captions under 25 words and body text under about 80 characters per line.

SEMANTICS — the page's accessibility comes entirely from the markup you write, so use real elements: a genuine <table> with a <caption> and <th scope="col"> for tabular data, <ol> for anything ordered, <ul> for unordered lists, and headings in a sensible order. Never fake a table with divs.

SIZING — size the page to its content. Never use viewport-relative units (vh, vw, svh, dvh) for heights or min-heights, and never set a percentage height on html or body: this document is displayed inside a frame that is resized to fit it, so anything that sizes itself from the frame's height works against that resizing.

PRINT — the reader can save this page as a PDF, so keep it printable. Put "break-inside: avoid" on cards, sections, tables, figures and any SVG diagram, so a page break never splits one down the middle. Avoid position:fixed and position:sticky, which print in the wrong place or not at all.

Before finalizing, check your own HTML/SVG for overlapping text, clipped labels, or elements that overflow their container, and for anything that would overflow at a narrow (400px) viewport width. Fix anything you find.

Reply with ONLY the finished HTML document — starting with <!DOCTYPE html> and ending with </html>. No explanation, no markdown code fence, nothing outside the document.`;
