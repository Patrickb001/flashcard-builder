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
 * bundle. (Task 3's `linkedom` import is the one exception, and is safe for
 * this reason: it is a pure-JS DOM implementation with no `window`.)
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
6. Keep every string short — this feeds a glance-able visual, not a document.`;
}

/** One prompt per detail level — the level controls how much content the extraction call asks for. */
export const INFOGRAPHIC_EXTRACT_PROMPTS: Record<InfographicDetail, string> = {
  basic: buildExtractionPrompt('basic'),
  standard: buildExtractionPrompt('standard'),
  detailed: buildExtractionPrompt('detailed'),
};

/** Trims and clamps to `max` chars with a trailing ellipsis; null if nothing survives. */
function clampText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

function validateItem(raw: unknown): ExtractedInfographicItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const label = clampText(item.label, 60);
  const detail = clampText(item.detail, 200);
  if (!label || !detail) return null;
  const meta = clampText(item.meta, 40);
  return meta ? { label, detail, meta } : { label, detail };
}

function validateComparison(raw: unknown): ExtractedInfographicComparison | null {
  if (!raw || typeof raw !== 'object') return null;
  const comparison = raw as Record<string, unknown>;
  const name = clampText(comparison.name, 60);
  const value = clampText(comparison.value, 60);
  if (!name || !value) return null;
  return { name, value };
}

function validateCoreConcept(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>)
    .map((entry): [string, string] | null => {
      const key = clampText(entry[0], 40);
      const value = clampText(entry[1], 80);
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

  const title = clampText(raw.title, 80) ?? deckName;
  const lede = clampText(raw.lede, 220) ?? '';
  const keyTakeaway = clampText(raw.keyTakeaway, 220) ?? '';
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
