import type { AiSettings } from './aiGenerator';
import { CARD_SYSTEM_PROMPT } from './cardPrompt';
import { QUIZ_SYSTEM_PROMPT } from './quizPrompt';

/**
 * Getting a payload to the model, by whichever route is available.
 *
 * Two transports, as before:
 *
 *  - "hosted": POST to /api/generate, a serverless function holding the API key
 *    server-side, so a visitor to a deployed site needs no key of their own.
 *  - "byok":   call the Anthropic API straight from the browser with a key the
 *    user pasted. Useful when running locally with no backend.
 *
 * This was private to the card generator until questions needed the same two
 * routes. Shared rather than copied: the two differ only in which prompt they
 * ask for, and a second copy of the fetch logic is a second place for the error
 * handling and the headers to drift apart.
 */

/**
 * Which prompt the server should answer with.
 *
 * The client names a task; it never sends a prompt. The server holds the text
 * and looks it up — see the lookup in netlify/functions/generate.mts for why
 * that boundary matters.
 */
export type AiTask = 'cards' | 'quiz';

/** The prompts, for the direct-from-browser route which has no server to ask. */
const PROMPTS: Record<AiTask, string> = {
  cards: CARD_SYSTEM_PROMPT,
  quiz: QUIZ_SYSTEM_PROMPT,
};

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 4000;

async function callHosted(task: AiTask, payload: unknown, signal?: AbortSignal): Promise<string> {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // The field is still called "sections" though it now sometimes carries
    // cards. It means "the JSON for the model"; renaming it would break the
    // deployed function for no gain.
    body: JSON.stringify({ task, sections: payload }),
    signal,
  });
  if (res.status === 404) {
    throw new Error(
      'The /api/generate endpoint was not found. Start the app with `npm run dev` from the project root so the dev server serves it.'
    );
  }
  if (!res.ok) {
    let detail = await res.text().catch(() => '');
    try {
      const parsed = JSON.parse(detail);
      detail = [parsed.error, parsed.detail].filter(Boolean).join(' — ');
    } catch {
      // Keep the raw body when it is not JSON.
    }
    throw new Error(detail || `Drafting service returned ${res.status}.`);
  }
  const data = await res.json();
  return typeof data.text === 'string' ? data.text : '';
}

async function callDirect(
  task: AiTask,
  payload: unknown,
  apiKey: string,
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Required for browser-originated calls.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: PROMPTS[task],
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    }),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Anthropic API returned ${res.status}. ${detail}`.trim());
  }

  const data = await res.json();
  return (data.content ?? [])
    .map((part: { type: string; text?: string }) => (part.type === 'text' ? part.text ?? '' : ''))
    .join('\n');
}

/**
 * Sends one payload and returns the model's raw text.
 *
 * A "byok" setting with no key falls through to the hosted route rather than
 * failing. That is the behaviour card drafting has always had, and matching it
 * is what keeps the two features available under exactly the same conditions.
 */
export function callModel(
  task: AiTask,
  payload: unknown,
  settings: AiSettings,
  signal?: AbortSignal
): Promise<string> {
  return settings.mode === 'byok' && settings.apiKey
    ? callDirect(task, payload, settings.apiKey, signal)
    : callHosted(task, payload, signal);
}
