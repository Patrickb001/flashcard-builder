import { stripJsonFence } from './textUtils';
import type {
  BulletsBlock,
  CalloutBlock,
  CompareBlock,
  CompareColumn,
  InfographicBlock,
  InfographicDetail,
  InfographicIcon,
  LlmInfographic,
  QuoteBlock,
  StatBlock,
  StepsBlock,
  TableBlock,
  TimelineBlock,
} from '../types';

/**
 * Turns a deck's flashcards into one infographic — a title plus a set of
 * typed blocks (bullets, timeline, table, callout, stat, compare, steps,
 * quote), not just icon-and-bullet sections. Shared between the browser
 * (bring-your-own-key mode) and the serverless function, exactly as the
 * card and quiz prompts are. This module must import nothing at runtime
 * beyond other such modules — the Netlify function imports it, and a stray
 * reference to the DOM or to localStorage would follow it into the server
 * bundle.
 */

const ICONS: InfographicIcon[] = [
  'book',
  'lightbulb',
  'brain',
  'chart',
  'list',
  'arrows',
  'target',
  'clock',
  'check',
  'warning',
  'network',
  'question',
];

/** The per-level ceiling on total blocks, and the level-independent ceiling
 * shared by every "list of short strings" field (bullets' points, steps'
 * items, a compare column's points) — the same numbers the old per-section
 * points ceiling used, now spent per-list rather than per-section. */
const TOTAL_BLOCKS_CEILING: Record<InfographicDetail, number> = { basic: 3, standard: 6, detailed: 10 };
const POINTS_CEILING: Record<InfographicDetail, number> = { basic: 4, standard: 5, detailed: 6 };

/** At most this many of each "dense" block type, regardless of level —
 * keeps Detailed from turning into ten tables back to back. */
const DENSE_TYPE_CEILING: Record<'stat' | 'compare' | 'table', number> = { stat: 1, compare: 1, table: 2 };

/** Per-level target guidance, folded into each level's own prompt text below. */
const TARGET_GUIDANCE: Record<InfographicDetail, string> = {
  basic: 'roughly 2-3 blocks',
  standard: 'roughly 4-6 blocks',
  detailed: 'roughly 7-10 blocks',
};

/** Basic keeps this short deliberately — with only 2-3 blocks, there's rarely
 * room for more than the default type plus maybe one standout number. */
const BLOCK_RUBRIC_BASIC = `Stick mostly to "bullets"; reach for "stat" only if one number is genuinely worth calling out on its own.`;

const BLOCK_RUBRIC_FULL = `Pick whichever block best fits each idea — do not default to "bullets" for everything:
- bullets — a short list of related points under one heading. The default when nothing more specific applies.
- timeline — steps that each have a real time or interval label (e.g. "1 day", "3 days"). Use "steps" instead when the sequence has no time attached.
- table — data that reads naturally as rows and columns (e.g. options and their effects).
- callout — one important warning or note that deserves visual emphasis, not another bullet.
- stat — one standout number worth calling out on its own, not a list of several numbers.
- compare — exactly two things being weighed against each other, never more than two.
- steps — an ordered process or sequence with no time labels attached.
- quote — one idea pulled from a single card. Light rewording for clarity or brevity is fine, but never add a claim the card didn't make.`;

const BLOCK_FIELDS_BASIC = `Each block type's own fields:
- bullets: icon, heading, points (array of short strings)
- stat: heading, value (a short number or figure), unit (optional, e.g. "days"), caption (one sentence)`;

const BLOCK_FIELDS_FULL = `Each block type's own fields:
- bullets: icon, heading, points (array of short strings)
- timeline: icon, heading, steps (array of { "label": "a short time label" }), caption (one sentence)
- table: heading, columns (array of short column names), rows (array of arrays of short cell strings, one array per row)
- callout: tone ("warning" or "info"), text (one to two sentences)
- stat: heading, value (a short number or figure), unit (optional, e.g. "days"), caption (one sentence)
- compare: heading, left and right (each { "label": "a short column name", "points": ["a short point", ...] })
- steps: heading, items (array of short strings, one per step)
- quote: text (one idea from a single card, one to two sentences)`;

function buildInfographicPrompt(detail: InfographicDetail): string {
  const rubric = detail === 'basic' ? BLOCK_RUBRIC_BASIC : BLOCK_RUBRIC_FULL;
  const fields = detail === 'basic' ? BLOCK_FIELDS_BASIC : BLOCK_FIELDS_FULL;
  return `You turn a student's flashcards into a single-page-style infographic they can use to review the material at a glance.

You are given some flashcards from one deck (front, back, and sometimes a topic). Write ${TARGET_GUIDANCE[detail]} — aim for that range, but it is a guide, not a hard limit; write what the material actually supports.

${rubric}

Reply with ONLY a JSON object, no prose before or after, shaped exactly like this:

{
  "title": "A short title for the whole infographic",
  "blocks": [
    { "type": "bullets", "icon": "one of the icon names below", "heading": "A short heading", "points": ["A short point.", "Another short point."] },
    { "type": "stat", "heading": "A short heading", "value": "62", "unit": "days", "caption": "One sentence of context." }
  ]
}

${fields}

Rules:
1. SYNTHESIZE, DON'T TRANSCRIBE — a point should read as a distilled idea, not a card's back pasted in verbatim. Group related cards into one block rather than writing one block per card.
2. icon (on "bullets" and "timeline" blocks only — no other block type takes an icon) MUST be exactly one of: ${ICONS.join(', ')}. Pick whichever reads best for that block's topic; never invent a name outside this list.
3. Keep headings, points, and captions short — this is read at a glance, not studied line by line.
4. Every block needs whatever its own fields require above; never return an empty blocks array.`;
}

/**
 * One prompt per detail level — not one shared prompt with the level named
 * in the payload. Two reasons: it matches how this file's neighbor,
 * quizPrompt.ts, already splits "vignette" from "vignette-audit" as
 * separate tasks rather than one task with a mode field; and more
 * concretely, the server's request validator (generateHandler.ts) requires
 * every task's payload to be a plain array ("Expected a non-empty
 * 'sections' array") — an object payload carrying `{ detail, cards }`
 * would be rejected by hosted mode before ever reaching the model. So
 * `detail` travels as *which task* gets called (see TASK_BY_DETAIL in
 * infographicGenerator.ts), never as extra payload content.
 */
export const INFOGRAPHIC_SYSTEM_PROMPTS: Record<InfographicDetail, string> = {
  basic: buildInfographicPrompt('basic'),
  standard: buildInfographicPrompt('standard'),
  detailed: buildInfographicPrompt('detailed'),
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Trims and clamps to `max` chars with a trailing ellipsis; null if nothing survives. */
function clampText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/**
 * Filter-then-slice, never slice-then-filter, for every "list of short
 * strings" field clamped below (bullets' points, a compare column's
 * points, steps' items) and for table's rows. A blank entry has to be
 * dropped before the ceiling slice runs, not after — a trailing filter
 * would let a blank consume a slot in the slice and silently crowd out a
 * good entry that came right after it in the model's reply.
 */
function validateBullets(raw: Record<string, unknown>, detail: InfographicDetail): BulletsBlock | null {
  if (!isNonEmptyString(raw.heading)) return null;
  if (!Array.isArray(raw.points)) return null;
  const points = raw.points
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .slice(0, POINTS_CEILING[detail]);
  if (points.length === 0) return null;
  const icon = typeof raw.icon === 'string' && (ICONS as string[]).includes(raw.icon) ? (raw.icon as InfographicIcon) : ('list' as const);
  return { type: 'bullets', icon, heading: (raw.heading as string).trim(), points };
}

function validateCallout(raw: Record<string, unknown>): CalloutBlock | null {
  const text = clampText(raw.text, 220);
  if (!text) return null;
  const tone = raw.tone === 'info' ? 'info' : ('warning' as const);
  return { type: 'callout', tone, text };
}

function validateStat(raw: Record<string, unknown>): StatBlock | null {
  if (!isNonEmptyString(raw.heading)) return null;
  const value = clampText(raw.value, 12);
  if (!value) return null;
  const caption = clampText(raw.caption, 140) ?? '';
  const unit = typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit.trim() : undefined;
  return { type: 'stat', heading: (raw.heading as string).trim(), value, ...(unit ? { unit } : {}), caption };
}

function validateQuote(raw: Record<string, unknown>): QuoteBlock | null {
  const text = clampText(raw.text, 200);
  if (!text) return null;
  return { type: 'quote', text };
}

const TIMELINE_STEPS_CEILING = 6;
const TABLE_MAX_COLUMNS = 4;
const TABLE_MAX_ROWS = 6;
const TABLE_CELL_CHARS = 60;

function validateTimeline(raw: Record<string, unknown>): TimelineBlock | null {
  if (!isNonEmptyString(raw.heading)) return null;
  if (!Array.isArray(raw.steps)) return null;
  const steps = raw.steps
    .map((s) => (s && typeof s === 'object' ? (s as { label?: unknown }).label : undefined))
    .filter(isNonEmptyString)
    .slice(0, TIMELINE_STEPS_CEILING)
    .map((label) => ({ label: label.trim() }));
  if (steps.length === 0) return null;
  const icon = typeof raw.icon === 'string' && (ICONS as string[]).includes(raw.icon) ? (raw.icon as InfographicIcon) : ('clock' as const);
  const caption = clampText(raw.caption, 140) ?? '';
  return { type: 'timeline', icon, heading: (raw.heading as string).trim(), steps, caption };
}

function validateTable(raw: Record<string, unknown>): TableBlock | null {
  if (!isNonEmptyString(raw.heading)) return null;
  if (!Array.isArray(raw.columns) || !Array.isArray(raw.rows)) return null;
  const columns = raw.columns
    .filter(isNonEmptyString)
    .slice(0, TABLE_MAX_COLUMNS)
    .map((c) => clampText(c, TABLE_CELL_CHARS) as string);
  if (columns.length === 0) return null;
  const rows = raw.rows
    .filter((r): r is unknown[] => Array.isArray(r) && r.length > 0)
    .slice(0, TABLE_MAX_ROWS)
    .map((r) => {
      const cells = r.slice(0, columns.length).map((cell) => clampText(cell, TABLE_CELL_CHARS) ?? '');
      // Pad a row shorter than the kept column count so every row has
      // exactly as many cells as there are headers.
      while (cells.length < columns.length) cells.push('');
      return cells;
    });
  if (rows.length === 0) return null;
  return { type: 'table', heading: (raw.heading as string).trim(), columns, rows };
}

function validateCompareColumn(raw: unknown, detail: InfographicDetail): CompareColumn | null {
  if (!raw || typeof raw !== 'object') return null;
  const col = raw as { label?: unknown; points?: unknown };
  if (!isNonEmptyString(col.label) || !Array.isArray(col.points)) return null;
  const points = col.points
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .slice(0, POINTS_CEILING[detail]);
  if (points.length === 0) return null;
  return { label: col.label.trim(), points };
}

function validateCompare(raw: Record<string, unknown>, detail: InfographicDetail): CompareBlock | null {
  if (!isNonEmptyString(raw.heading)) return null;
  const left = validateCompareColumn(raw.left, detail);
  const right = validateCompareColumn(raw.right, detail);
  if (!left || !right) return null;
  return { type: 'compare', heading: (raw.heading as string).trim(), left, right };
}

function validateSteps(raw: Record<string, unknown>, detail: InfographicDetail): StepsBlock | null {
  if (!isNonEmptyString(raw.heading)) return null;
  if (!Array.isArray(raw.items)) return null;
  const items = raw.items
    .filter((i): i is string => typeof i === 'string')
    .map((i) => i.trim())
    .filter((i) => i.length > 0)
    .slice(0, POINTS_CEILING[detail]);
  if (items.length === 0) return null;
  return { type: 'steps', heading: (raw.heading as string).trim(), items };
}

/**
 * One switch per block type, covering all 8 block types by name. Only a
 * genuinely unrecognized `type` string falls through to `default` and is
 * dropped, the same treatment an unrecognized `icon` already gets.
 */
function validateBlock(raw: unknown, detail: InfographicDetail): InfographicBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  switch (item.type) {
    case 'bullets':
      return validateBullets(item, detail);
    case 'callout':
      return validateCallout(item);
    case 'stat':
      return validateStat(item);
    case 'quote':
      return validateQuote(item);
    case 'timeline':
      return validateTimeline(item);
    case 'table':
      return validateTable(item);
    case 'compare':
      return validateCompare(item, detail);
    case 'steps':
      return validateSteps(item, detail);
    default:
      return null;
  }
}

/** Applies the total-block ceiling and the dense-type combined cap, in
 * order — a dense block that's over its own cap is skipped without
 * consuming a slot in the total ceiling, so a later non-dense block can
 * still take its place. */
function applyBlockCeilings(blocks: InfographicBlock[], detail: InfographicDetail): InfographicBlock[] {
  const denseUsed: Record<'stat' | 'compare' | 'table', number> = { stat: 0, compare: 0, table: 0 };
  const kept: InfographicBlock[] = [];
  for (const block of blocks) {
    if (kept.length >= TOTAL_BLOCKS_CEILING[detail]) break;
    if (block.type === 'stat' || block.type === 'compare' || block.type === 'table') {
      if (denseUsed[block.type] >= DENSE_TYPE_CEILING[block.type]) continue;
      denseUsed[block.type] += 1;
    }
    kept.push(block);
  }
  return kept;
}

/**
 * Reads the model's reply as one JSON object, tolerating a markdown fence,
 * then validates and clamps each block, then applies the total/dense-type
 * ceilings above. Clamps rather than rejects a single block, so one
 * malformed block among several good ones doesn't throw the whole reply
 * away.
 *
 * Returns null only when nothing usable could be read at all: the reply
 * isn't a JSON object, or it parses but zero blocks survive.
 */
export function parseInfographicResponse(
  text: string,
  deckName: string,
  detail: InfographicDetail
): LlmInfographic | null {
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

  const raw = parsed as { title?: unknown; blocks?: unknown };
  if (!Array.isArray(raw.blocks)) return null;

  const validated = raw.blocks
    .map((item) => validateBlock(item, detail))
    .filter((block): block is InfographicBlock => block !== null);

  const blocks = applyBlockCeilings(validated, detail);
  if (blocks.length === 0) return null;

  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : deckName;

  return { title, blocks };
}
