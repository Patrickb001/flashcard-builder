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

/**
 * Response ceiling per task.
 *
 * A quiz question costs about five strings where a card costs two, so a quiz
 * batch sits far closer to the ceiling. At 4000 a full batch came back
 * truncated mid-JSON and the salvage pass quietly lost the tail — the cause of
 * test generation only ever covering part of a deck. A batch of eight at the
 * measured cost leaves a wide margin instead of sitting on a cliff.
 *
 * Cards were left at 4000 on the assumption that two strings a card could not
 * reach it. A dense reference page defeats that: the prompt asks for one card
 * per table cell and one per defined term, so a lecture slide of four bulleted
 * quadrants alone is worth twenty cards, and a batch of such pages asks for
 * fifty or more. A 16-page clinical deck hit the ceiling on three batches out
 * of four and silently fell back to rule-based cards for three quarters of the
 * document.
 *
 * The ceiling is a limit, not a reservation — an ordinary batch still generates
 * and bills a couple of thousand tokens — so the headroom is close to free.
 */
const MAX_TOKENS: Record<AiTask, number> = {
  cards: 16000,
  quiz: 8000,
};

/**
 * How long one request may run before it is abandoned.
 *
 * There was no timeout on this path at all: a request that never answered left
 * "Claude is drafting cards" on screen indefinitely, with no way forward and
 * nothing logged. Generous rather than tight, because a large batch at the card
 * ceiling legitimately takes a while, and a batch abandoned early is a batch
 * that falls back to rule-based cards for no reason.
 */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * A signal that fires on the caller's abort or on our own timeout.
 *
 * `AbortSignal.any` would say this in one line but is too new to rely on in
 * every browser this runs in, so the two are wired together by hand. The timer
 * is returned alongside so the caller can clear it — an uncleared 120-second
 * timer keeps a reference to the controller for two minutes after the request
 * it was guarding has already answered.
 */
function withTimeout(signal?: AbortSignal): {
  signal: AbortSignal;
  /** True when it was the timer, not the caller, that aborted the request. */
  timedOut: () => boolean;
  done: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Turns a timeout's abort into an ordinary failure.
 *
 * The two aborts have to stay distinguishable. A run the user stopped is not a
 * failure and must end the whole run quietly; a request that timed out is a
 * failure of one batch, which should be retried and then fall back. Both arrive
 * here as the same AbortError, and letting a timeout keep that name would make
 * one slow request look like the user pressing Stop and abandon every batch
 * after it.
 */
function rethrowAsTimeout(err: unknown, guard: { timedOut: () => boolean }): never {
  if (guard.timedOut()) {
    throw new Error(
      `The drafting request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`
    );
  }
  throw err;
}

/**
 * The model's reply, with the reason it stopped.
 *
 * "stopReason" is what lets a caller tell a response that was cut off from one
 * where the model genuinely had nothing to say. The two need different
 * messages, and until now neither reached the client: the server returned only
 * the text.
 */
export interface ModelReply {
  text: string;
  stopReason: string | null;
}

async function callHosted(task: AiTask, payload: unknown, signal?: AbortSignal): Promise<ModelReply> {
  const guard = withTimeout(signal);
  let res: Response;
  try {
    res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The field is still called "sections" though it now sometimes carries
      // cards. It means "the JSON for the model"; renaming it would break the
      // deployed function for no gain.
      body: JSON.stringify({ task, sections: payload }),
      signal: guard.signal,
    });
  } catch (err) {
    rethrowAsTimeout(err, guard);
  } finally {
    guard.done();
  }
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
  const data = (await res.json()) as { text?: unknown; stopReason?: unknown };
  return {
    text: typeof data.text === 'string' ? data.text : '',
    stopReason: typeof data.stopReason === 'string' ? data.stopReason : null,
  };
}

async function callDirect(
  task: AiTask,
  payload: unknown,
  apiKey: string,
  signal?: AbortSignal
): Promise<ModelReply> {
  const guard = withTimeout(signal);
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
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
        max_tokens: MAX_TOKENS[task],
        // Sent as a cacheable block rather than a bare string. The prompt is
        // byte-identical on every request of a run and sits ahead of the batch
        // payload, so after the first request the rest of the run reads it from
        // cache. Drafting a document is many requests behind one long prompt,
        // which is exactly the shape caching pays for.
        system: [
          { type: 'text', text: PROMPTS[task], cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: JSON.stringify(payload) }],
      }),
      signal: guard.signal,
    });
  } catch (err) {
    rethrowAsTimeout(err, guard);
  } finally {
    guard.done();
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Anthropic API returned ${res.status}. ${detail}`.trim());
  }

  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
    stop_reason?: unknown;
  };
  const text = (data.content ?? [])
    .map((part: { type: string; text?: string }) => (part.type === 'text' ? part.text ?? '' : ''))
    .join('\n');
  return { text, stopReason: typeof data.stop_reason === 'string' ? data.stop_reason : null };
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
): Promise<ModelReply> {
  return settings.mode === 'byok' && settings.apiKey
    ? callDirect(task, payload, settings.apiKey, signal)
    : callHosted(task, payload, signal);
}
