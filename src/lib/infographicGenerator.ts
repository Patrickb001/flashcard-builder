import type { AiSettings } from './aiGenerator';
import type { AiTask } from './aiTransport';
import { callModel } from './aiTransport';
import { parseDesignResponse, parseExtractionResponse } from './infographicPrompt';
import type { Flashcard, Infographic, InfographicDetail } from '../types';

/** Which AiTask a given detail level's extraction call uses. The design call has no per-level variant. */
const EXTRACT_TASK_BY_DETAIL: Record<InfographicDetail, AiTask> = {
  basic: 'infographic-extract-basic',
  standard: 'infographic-extract-standard',
  detailed: 'infographic-extract-detailed',
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

/** Which of the two model calls is in flight — read by InfographicMode.tsx's generating screen. */
export type InfographicStage = 'extracting' | 'designing';

/**
 * Turns a chosen set of a deck's cards into one saved-shaped Infographic,
 * through two sequential model calls: extraction (cards in, structured
 * content out), then design (that content in, a self-contained HTML
 * document out). `onStage` fires once before each call, so a caller can
 * show what's actually happening rather than one static "generating" line
 * for the whole run.
 *
 * Neither call is batched or retried — the target outputs (a small JSON
 * object, then one HTML page) never approach a size that needs splitting
 * across requests. The *input* to the first call can still be large on a
 * big deck, which is what MAX_FIELD_CHARS guards against.
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
  signal?: AbortSignal,
  onStage?: (stage: InfographicStage) => void
): Promise<Infographic> {
  const cardsPayload = cards.map((card) => ({
    front: truncate(card.front, MAX_FIELD_CHARS),
    back: truncate(card.back, MAX_FIELD_CHARS),
    context: card.context ? truncate(card.context, MAX_FIELD_CHARS) : card.context,
  }));

  onStage?.('extracting');
  const extractReply = await callModel(EXTRACT_TASK_BY_DETAIL[detail], cardsPayload, settings, signal);
  if (extractReply.stopReason === 'max_tokens') {
    throw new Error('The reply was cut off before it finished — try Basic or Standard, or choose fewer cards.');
  }
  const extracted = parseExtractionResponse(extractReply.text, deckName, detail);
  if (!extracted) {
    throw new Error("The infographic's content could not be read from the model's reply.");
  }

  // The design call's payload is one JSON object, not an array of cards —
  // it still has to travel as a single-element array, since callModel's
  // hosted route requires a non-empty array payload (see generateHandler.ts).
  onStage?.('designing');
  const designReply = await callModel('infographic-design', [extracted], settings, signal);
  if (designReply.stopReason === 'max_tokens') {
    throw new Error('The generated page was cut off before it finished — try Basic or Standard, or choose fewer cards.');
  }
  const html = parseDesignResponse(designReply.text);
  if (!html) {
    throw new Error("The infographic's page could not be read from the model's reply.");
  }

  return {
    id: crypto.randomUUID(),
    deckId,
    title: extracted.title,
    detail,
    html,
    cardIds: cards.map((card) => card.id),
    createdAt: Date.now(),
  };
}
