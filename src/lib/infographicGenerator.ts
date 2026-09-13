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

/**
 * Turns a chosen set of a deck's cards into one saved-shaped Infographic.
 *
 * A single request, unlike card drafting — there is no batching or retry
 * pass here, since the target output (a handful of sections) never
 * approaches a size that needs splitting across requests.
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
    front: card.front,
    back: card.back,
    context: card.context,
  }));

  const { text } = await callModel(TASK_BY_DETAIL[detail], payload, settings, signal);
  const parsed = parseInfographicResponse(text, deckName, detail);
  if (!parsed) {
    throw new Error('The infographic could not be read from the model\'s reply.');
  }

  return {
    id: crypto.randomUUID(),
    deckId,
    title: parsed.title,
    detail,
    sections: parsed.sections,
    cardIds: cards.map((card) => card.id),
    createdAt: Date.now(),
  };
}
