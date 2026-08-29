import type { Config, Context } from '@netlify/functions';
import { fetchPageHtml, PageFetchError } from '../../src/lib/fetchPage';

/**
 * Reads a web page on behalf of the browser.
 *
 * Cross-origin rules stop the app from fetching another site's HTML itself, so
 * this does it server-side and hands back the markup; the parsing still happens
 * in the browser. The URL guards live in src/lib/fetchPage.ts, shared with the
 * dev server so both paths refuse the same addresses.
 */

// Crude in-memory throttle, matching generate.mts: function instances are
// recycled, so this is a speed bump against casual abuse, not a real quota.
const RATE_LIMIT_PER_MINUTE = 10;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT_PER_MINUTE;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const ip = context.ip ?? 'unknown';
  if (rateLimited(ip)) {
    return json({ error: 'Too many pages requested. Try again shortly.' }, 429);
  }

  let url: unknown;
  try {
    ({ url } = await req.json());
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  if (typeof url !== 'string' || !url.trim()) {
    return json({ error: 'Expected a "url" string.' }, 400);
  }

  try {
    return json(await fetchPageHtml(url), 200);
  } catch (err) {
    // The fetcher's messages are written to be shown to a person and reveal
    // nothing about the server's own network.
    const message = err instanceof Error ? err.message : 'Could not read that page.';
    return json({ error: message }, err instanceof PageFetchError ? err.status : 502);
  }
};

export const config: Config = {
  path: '/api/fetch-page',
};
