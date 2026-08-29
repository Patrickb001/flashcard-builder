/**
 * The parts of an HTTP endpoint that both deployments share.
 *
 * There are two runtimes: Netlify functions in production, and Connect
 * middleware inside the Vite dev server locally. They used to hold a hand-kept
 * copy of the same endpoint each, and had drifted apart in six ways — the dev
 * copy had no rate limiting, answered 405 with a different body shape, and
 * corrupted UTF-8 on the way in.
 *
 * So the runtime-specific part is now only: get the method, the caller's
 * address, and the raw body text. Everything after that happens here, once.
 *
 * Nothing in this directory may touch `process`, the DOM, or any Node built-in:
 * these files are type-checked under both the app and the Node configs, and the
 * request body arrives as a string precisely so that decoding stays the
 * adapter's problem.
 */

/** What a handler returns: a status and a body to be serialised as JSON. */
export interface HandlerResult {
  status: number;
  body: unknown;
}

/** Requests from one address are tracked for this long. */
const WINDOW_MS = 60_000;

/**
 * Addresses tracked before stale ones are swept.
 *
 * The map this replaces was never pruned, so a warm function instance kept one
 * entry per unique address for as long as it lived. Sweeping only once the map
 * is large keeps the usual request free of the cost.
 */
const MAX_TRACKED = 1000;

/**
 * A per-address request throttle.
 *
 * Crude on purpose: function instances are recycled, so this is a speed bump
 * against casual abuse rather than a real quota. Put a proper limiter or auth in
 * front of a public deployment.
 */
export function createRateLimiter(perMinute: number): (address: string) => boolean {
  const hits = new Map<string, number[]>();

  return (address: string): boolean => {
    const now = Date.now();

    if (hits.size > MAX_TRACKED) {
      for (const [key, times] of hits) {
        if (times.length === 0 || now - times[times.length - 1] >= WINDOW_MS) hits.delete(key);
      }
    }

    const recent = (hits.get(address) ?? []).filter((t) => now - t < WINDOW_MS);
    recent.push(now);
    hits.set(address, recent);
    return recent.length > perMinute;
  };
}

/**
 * Decodes a request body that arrived in pieces.
 *
 * The whole body is assembled first and decoded once. Appending each chunk to a
 * string instead decodes every ~64KB socket chunk on its own, so a multi-byte
 * character straddling a chunk boundary loses half of itself on each side and
 * becomes two U+FFFD replacement characters — an em-dash typed into a card
 * would survive in production and corrupt locally, because the two deployments
 * read bodies differently.
 *
 * Uint8Array and TextDecoder rather than Buffer, so this stays free of Node
 * built-ins and can be checked under the app config alongside everything else
 * in this directory.
 */
export function decodeBody(chunks: Uint8Array[]): string {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;

  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }

  return new TextDecoder('utf-8').decode(joined);
}

export interface EndpointRequest {
  method: string | undefined;
  /** The caller's address, for throttling. */
  address: string;
  /** The request body, already decoded as UTF-8. */
  rawBody: string;
}

/**
 * Runs the shared front half of an endpoint, then the handler.
 *
 * Method check, throttle and JSON parse all happen here so the two deployments
 * cannot answer any of them differently — which they did: a 405 was JSON in
 * development and plain text in production, and the client parses that body, so
 * the error a user saw depended on where the app was running.
 */
export async function runEndpoint(
  request: EndpointRequest,
  options: {
    rateLimited: (address: string) => boolean;
    tooManyMessage: string;
    handle: (body: unknown) => Promise<HandlerResult>;
  }
): Promise<HandlerResult> {
  if (request.method !== 'POST') {
    return { status: 405, body: { error: 'Method not allowed' } };
  }

  if (options.rateLimited(request.address)) {
    return { status: 429, body: { error: options.tooManyMessage } };
  }

  let body: unknown;
  try {
    body = JSON.parse(request.rawBody);
  } catch {
    return { status: 400, body: { error: 'Invalid JSON body.' } };
  }

  return options.handle(body);
}
