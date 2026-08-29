import type { Config, Context } from '@netlify/functions';
import { CARD_SYSTEM_PROMPT } from '../../src/lib/cardPrompt';
import { QUIZ_SYSTEM_PROMPT } from '../../src/lib/quizPrompt';

/**
 * Server-side proxy for drafting cards and writing test questions.
 *
 * Holding the Anthropic key here (not in the browser) is what makes a deployed
 * site usable by people who do not have a key of their own. The key never
 * reaches the client.
 *
 * The prompts are imported rather than kept here. This file used to hold its
 * own copy of the card prompt, which fell behind the real one: it still
 * described an output shape with no code or image fields, so snippets and
 * diagrams attached to cards in local development and were silently dropped in
 * production. Importing removes the whole class of problem rather than fixing
 * one instance of it.
 */

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';

/**
 * Response ceiling per task.
 *
 * Quiz questions cost far more output than cards — five strings each rather
 * than two — and at 4000 a full batch was coming back truncated mid-JSON, so
 * the client silently lost the tail of every large batch. The client cannot
 * raise this: it is fixed here, deliberately, so a pasted key cannot run up an
 * unbounded bill.
 */
const MAX_TOKENS: Record<string, number> = { cards: 4000, quiz: 8000 };

// Crude in-memory throttle. Function instances are recycled, so this is a
// speed bump against casual abuse, not a real quota. For a public deployment,
// put a proper rate limiter or auth in front of this.
const RATE_LIMIT_PER_MINUTE = 20;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT_PER_MINUTE;
}

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
]);

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const ip = context.ip ?? 'unknown';
  if (rateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'Too many requests. Try again shortly.' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let sections: unknown;
  let task: unknown;
  try {
    ({ sections, task } = await req.json());
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!Array.isArray(sections) || sections.length === 0) {
    return new Response(JSON.stringify({ error: 'Expected a non-empty "sections" array.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // An older client sends no task at all, so the default keeps it working.
  const taskName = typeof task === 'string' && task ? task : 'cards';
  const systemPrompt = PROMPTS.get(taskName);
  if (!systemPrompt) {
    return new Response(JSON.stringify({ error: 'Unknown task.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = JSON.stringify(sections);
  // Guard against oversized payloads reaching the model.
  if (body.length > 120_000) {
    return new Response(JSON.stringify({ error: 'Payload too large.' }), {
      status: 413,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS[taskName] ?? MAX_TOKENS.cards,
        system: systemPrompt,
        messages: [{ role: 'user', content: body }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return new Response(
        JSON.stringify({ error: `Upstream error ${res.status}`, detail: detail.slice(0, 500) }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const data = await res.json();
    const text = (data.content ?? [])
      .map((part: { type: string; text?: string }) => (part.type === 'text' ? part.text ?? '' : ''))
      .join('\n');

    // stopReason travels with the text so the client can tell a truncated
    // response from a model that genuinely had nothing to add.
    return new Response(JSON.stringify({ text, stopReason: data.stop_reason ?? null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Request to the model failed.' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config: Config = {
  path: '/api/generate',
};
