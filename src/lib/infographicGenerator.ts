import type { AiSettings } from './aiGenerator';
import type { AiTask } from './aiTransport';
import { callModel } from './aiTransport';
import { parseInfographicResponse } from './infographicPrompt';
import type { Flashcard, Infographic, InfographicDetail } from '../types';

/** Which AiTask a given detail level calls — detail selects the task, not a payload field (see infographicPrompt.ts). */
const TASK_BY_DETAIL: Record<InfographicDetail, AiTask> = {
  basic: 'infographic-basic',
  standard: 'infographic-standard',
  detailed: 'infographic-detailed',
};

/** Per-field character caps on what a card sends. Keeps "All cards" on a large,
 * document-built deck well clear of the server's MAX_REQUEST_CHARS (120,000,
 * see generateHandler.ts) — the same reasoning quizGenerator.ts's own trimCard
 * already applies to this app's other multi-card payloads. */
const MAX_FIELD_CHARS = 400;

/** Collapses a field to one line and cuts it to `max`, matching quizGenerator.ts's truncate. */
function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

/**
 * Turns a chosen set of a deck's cards into one saved-shaped Infographic.
 *
 * A single request, unlike card drafting — there is no batching or retry
 * pass here, since the target output (a handful of sections) never
 * approaches a size that needs splitting across requests. The *input* can
 * still be large on a big deck, which is what MAX_FIELD_CHARS guards
 * against, separately from the output-side clamping in infographicPrompt.ts.
 *
 * Does not write anything to storage itself; the caller (InfographicMode)
 * calls saveInfographic with the result, keeping "generate" and "persist"
 * as separate steps the way the rest of the app already does.
 */
export async function generateInfographic(
  deckId: string,
  deckName: string,
  cards: Flashcard[],
  detail: InfographicDetail,
  settings: AiSettings,
  signal?: AbortSignal
): Promise<Infographic> {
  const payload = cards.map((card) => ({
    front: truncate(card.front, MAX_FIELD_CHARS),
    back: truncate(card.back, MAX_FIELD_CHARS),
    context: card.context ? truncate(card.context, MAX_FIELD_CHARS) : card.context,
  }));

  const { text, stopReason } = await callModel(TASK_BY_DETAIL[detail], payload, settings, signal);
  if (stopReason === 'max_tokens') {
    // Silently handing a cut-off reply to the parser would just look like
    // "could not be generated" with no hint why — this is the one failure
    // every other generator in this app already checks for explicitly
    // (aiGenerator.ts, ocrGenerator.ts, quizGenerator.ts).
    throw new Error('The reply was cut off before it finished — try Basic or Standard, or choose fewer cards.');
  }

  const parsed = parseInfographicResponse(text, deckName, detail);
  if (!parsed) {
    throw new Error('The infographic could not be read from the model\'s reply.');
  }

  return {
    id: crypto.randomUUID(),
    deckId,
    title: parsed.title,
    detail,
    blocks: parsed.blocks,
    cardIds: cards.map((card) => card.id),
    createdAt: Date.now(),
  };
}
