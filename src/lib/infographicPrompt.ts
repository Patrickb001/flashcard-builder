import { stripJsonFence } from './textUtils';
import type { InfographicDetail, InfographicIcon, LlmInfographic } from '../types';

/**
 * Turns a deck's flashcards into one infographic — a title plus a handful of
 * icon-and-bullet sections. Shared between the browser (bring-your-own-key
 * mode) and the serverless function, exactly as the card and quiz prompts
 * are. This module must import nothing at runtime beyond other such
 * modules — the Netlify function imports it, and a stray reference to the
 * DOM or to localStorage would follow it into the server bundle.
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

/**
 * Clamp ceilings per level — enforced by the parser below on whatever the
 * model actually returns. Distinct from the *targets* embedded in each
 * level's own prompt text below: never told to the model as a hard limit
 * the way these ceilings are enforced here.
 */
const CEILINGS: Record<InfographicDetail, { sections: number; points: number }> = {
  basic: { sections: 5, points: 4 },
  standard: { sections: 8, points: 5 },
  detailed: { sections: 14, points: 6 },
};

/** Per-level target guidance, folded into each level's own prompt text below. */
const TARGET_GUIDANCE: Record<InfographicDetail, string> = {
  basic: 'roughly 3-4 sections, 2-3 points each',
  standard: 'roughly 5-7 sections, 3-4 points each',
  detailed: 'roughly 8-12 sections, 3-5 points each',
};

function buildInfographicPrompt(detail: InfographicDetail): string {
  return `You turn a student's flashcards into a single-page-style infographic they can use to review the material at a glance.

You are given some flashcards from one deck (front, back, and sometimes a topic). Write ${TARGET_GUIDANCE[detail]} — aim for that range, but it is a guide, not a hard limit; write what the material actually supports.

Reply with ONLY a JSON object, no prose before or after, shaped exactly like this:

{
  "title": "A short title for the whole infographic",
  "sections": [
    { "heading": "A short section heading", "icon": "one of the icon names below", "points": ["A short point.", "Another short point."] }
  ]
}

Rules:
1. SYNTHESIZE, DON'T TRANSCRIBE — a point should read as a distilled idea, not a card's back pasted in verbatim. Group related cards into one section rather than writing one section per card.
2. icon MUST be exactly one of: ${ICONS.join(', ')}. Pick whichever reads best for that section's topic; never invent a name outside this list.
3. Keep headings and points short — this is read at a glance, not studied line by line.
4. Every section needs at least one point and a heading; never return an empty sections array.`;
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

/**
 * Reads the model's reply as one JSON object, tolerating a markdown fence,
 * then clamps its sections/points to the given level's ceiling. Clamps
 * rather than rejects, so a reply that ran a little long or a little short
 * of its target is still stored rather than thrown away.
 *
 * Returns null only when nothing usable could be read at all: the reply
 * isn't a JSON object, or it parses but has zero sections.
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

  const raw = parsed as { title?: unknown; sections?: unknown };
  if (!Array.isArray(raw.sections)) return null;

  const ceiling = CEILINGS[detail];
  const sections = raw.sections
    .filter(
      (item): item is { heading: string; icon: string; points: string[] } =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as { heading?: unknown }).heading === 'string' &&
        // Checked here, before the ceiling slice below, rather than as a
        // trailing filter after it — a trailing filter would drop a
        // whitespace-only-heading section AFTER it had already used up a
        // slot in the ceiling, silently crowding out a good section that
        // came right after it in the model's reply.
        (item as { heading: string }).heading.trim().length > 0 &&
        typeof (item as { icon?: unknown }).icon === 'string' &&
        Array.isArray((item as { points?: unknown }).points) &&
        (item as { points: unknown[] }).points.every((p) => typeof p === 'string')
    )
    .slice(0, ceiling.sections)
    .map((section) => ({
      heading: section.heading.trim(),
      icon: (ICONS as string[]).includes(section.icon) ? (section.icon as InfographicIcon) : ('list' as const),
      // Trimmed and stripped of anything that trims to nothing — a bullet
      // that's blank once trimmed would otherwise render as an empty <li>.
      points: section.points
        .slice(0, ceiling.points)
        .map((p) => p.trim())
        .filter((p) => p.length > 0),
    }))
    // A section that lost every point to the filter above (all-whitespace
    // points, or none survived) isn't a usable section either.
    .filter((section) => section.points.length > 0);

  if (sections.length === 0) return null;

  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : deckName;

  return { title, sections };
}
