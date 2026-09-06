import { CARD_SYSTEM_PROMPT } from '../lib/cardPrompt';
import { QUIZ_SYSTEM_PROMPT, VIGNETTE_SYSTEM_PROMPT, VIGNETTE_AUDIT_SYSTEM_PROMPT } from '../lib/quizPrompt';
import type { HandlerResult } from './endpoint';

/**
 * Drafting cards and writing test questions, server-side.
 *
 * Holding the Anthropic key on the server is what makes a deployed site usable
 * by people who have no key of their own; the key never reaches the client.
 *
 * The prompts are imported from src/lib rather than restated here, so a hosted
 * deployment and a bring-your-own-key browser cannot drift into asking the model
 * for different output shapes.
 */

/** Used when the deployment names no model of its own. */
const DEFAULT_MODEL = 'claude-sonnet-5';

/**
 * Response ceiling per task.
 *
 * Fixed here rather than accepted from the client, deliberately: a request
 * cannot ask the server to run up an unbounded bill.
 *
 * Must stay in step with MAX_TOKENS in src/lib/aiTransport.ts, or hosted and
 * bring-your-own-key mode draft differently from the same input. See "Model
 * response ceilings" in docs/tuning-notes.md for why each value is what it is.
 */
const MAX_TOKENS: Record<string, number> = {
  cards: 16000,
  quiz: 8000,
  vignette: 16000,
  'vignette-audit': 1000,
};

/**
 * The prompt each task is answered with.
 *
 * The client names a task; it never sends a prompt. A Map rather than an object
 * literal on purpose: indexing an object with a client-supplied string makes
 * "__proto__" and "constructor" return truthy values that are not undefined, so
 * a lookup guarded only by truthiness would wave them through.
 */
const PROMPTS = new Map<string, string>([
  ['cards', CARD_SYSTEM_PROMPT],
  ['quiz', QUIZ_SYSTEM_PROMPT],
  ['vignette', VIGNETTE_SYSTEM_PROMPT],
  ['vignette-audit', VIGNETTE_AUDIT_SYSTEM_PROMPT],
]);

/** Anything larger than this is refused before it reaches the model. */
const MAX_REQUEST_CHARS = 120_000;

export interface GenerateOptions {
  apiKey: string | undefined;
  /** Overrides DEFAULT_MODEL when the deployment sets one. */
  model?: string;
  /** Where to report an upstream failure; the terminal locally, the log in production. */
  onError?: (message: string) => void;
}

/**
 * The whole server contract for talking to the model: validate the request,
 * pick the prompt for the named task, call Anthropic, and shape the reply.
 *
 * Everything the client can influence is checked before a paid call is made —
 * the task must name a known prompt, the payload must be under the size cap,
 * and max_tokens is fixed here rather than accepted from the request.
 *
 * Never throws. Every failure, including an upstream one, comes back as a
 * HandlerResult with a status, because both adapters just serialise what they
 * are given.
 */
export async function handleGenerate(
  body: unknown,
  options: GenerateOptions
): Promise<HandlerResult> {
  if (!options.apiKey) {
    return {
      status: 500,
      body: {
        error:
          'ANTHROPIC_API_KEY is not set. Add it to a .env file in the project root, then restart the server.',
      },
    };
  }

  const { sections, task } = (body ?? {}) as { sections?: unknown; task?: unknown };

  if (!Array.isArray(sections) || sections.length === 0) {
    return { status: 400, body: { error: 'Expected a non-empty "sections" array.' } };
  }

  // An older client sends no task at all, so the default keeps it working.
  const taskName = typeof task === 'string' && task ? task : 'cards';
  const systemPrompt = PROMPTS.get(taskName);
  if (!systemPrompt) {
    return { status: 400, body: { error: 'Unknown task.' } };
  }

  const payload = JSON.stringify(sections);
  if (payload.length > MAX_REQUEST_CHARS) {
    return { status: 413, body: { error: 'Payload too large.' } };
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': options.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: options.model || DEFAULT_MODEL,
        max_tokens: MAX_TOKENS[taskName] ?? MAX_TOKENS.cards,
        // Sent as a cacheable block rather than a bare string. The prompt is
        // byte-identical on every request of a run and sits ahead of the batch
        // payload, so after the first request the rest of the run reads it from
        // cache. Drafting a document is many requests behind one long prompt,
        // which is exactly the shape caching pays for.
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: payload }],
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      options.onError?.(`Anthropic ${upstream.status}: ${detail.slice(0, 400)}`);
      return {
        status: 502,
        body: { error: `Anthropic returned ${upstream.status}`, detail: detail.slice(0, 500) },
      };
    }

    const data = await upstream.json();
    const text = ((data.content ?? []) as { type: string; text?: string }[])
      .map((part) => (part.type === 'text' ? part.text ?? '' : ''))
      .join('\n');

    // stopReason travels with the text so the client can tell a reply cut off
    // by the ceiling from a model that genuinely had nothing to add.
    return { status: 200, body: { text, stopReason: data.stop_reason ?? null } };
  } catch (err) {
    options.onError?.(`request failed: ${err instanceof Error ? err.message : String(err)}`);
    return { status: 502, body: { error: 'Request to the model failed.' } };
  }
}
