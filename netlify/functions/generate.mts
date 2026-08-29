import type { Config, Context } from '@netlify/functions';

/**
 * Server-side proxy for card drafting.
 *
 * Holding the Anthropic key here (not in the browser) is what makes a deployed
 * site usable by people who do not have a key of their own. The key never
 * reaches the client.
 */

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';

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

const SYSTEM_PROMPT = `You write flashcards for a student who will study only from the cards, without re-reading the source. You are given structured blocks extracted from one section of a document.

Write cards that satisfy ALL of these:

1. ATOMIC — one fact per card. Split compound statements into separate cards.
2. SELF-CONTAINED — the question must make sense with no other context. Never write "What is important about this?" or refer to "the above", "the following", "this example".
3. REAL QUESTIONS — the front must read as a natural question a tutor would ask, not a label with a question mark appended. Prefer "What are the adult implications of avoidant attachment?" over "Avoidant — Adult Implications?".
4. GROUNDED — use only facts present in the blocks. Never add outside knowledge, never guess, never fill gaps. If a block is navigation, boilerplate, a page header, a code caption, or a table of contents, skip it entirely.
5. ANSWERABLE FROM RECALL — the back should be 1-2 sentences or a short list, under about 50 words. If a passage is too long, split it into several cards rather than pasting it.
6. SPECIFIC TERMS — when the section defines a named concept, always produce a card for that definition.

Also:
- If a fact pairs a name with a range, quantity, or classification (a stage and its age range, a pattern and its prevalence), emit that as its own separate card.
- For tables, emit one card per meaningful cell, phrased using the row and column headers.
- For code blocks, ask what the snippet accomplishes, which API it uses, or how a task is done, and put the short answer — a phrase, an expression, or two or three lines of code copied verbatim — on the back. A snippet that only repeats an import or boilerplate setup is not worth a card.
- Preserve exact numbers, percentages, and technical identifiers verbatim. Do not round or paraphrase them.
- Skip anything that is not worth memorising. Returning few cards is better than returning filler.

Return ONLY a JSON array, with no markdown fence and no commentary. Each element:
{"front": string, "back": string, "context": string}

"context" is a short topic label (2-5 words) naming what the card is about, used as a chip on the card. Return [] if the section has nothing worth learning.`;

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
  try {
    ({ sections } = await req.json());
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
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
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

    return new Response(JSON.stringify({ text }), {
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
