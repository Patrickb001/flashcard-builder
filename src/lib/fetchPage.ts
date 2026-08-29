/**
 * Server-side page fetching.
 *
 * The browser cannot fetch an arbitrary page itself — the cross-origin rules
 * that protect every other site apply here too — so the dev server and the
 * Netlify function both proxy it through this module. Nothing here runs in the
 * browser.
 *
 * A proxy that fetches whatever URL it is handed is a server-side request
 * forgery hole: without checks, anyone who can reach the endpoint can use the
 * server to read addresses only the server can reach — a cloud instance's
 * metadata service, an internal admin page, a database on localhost. The guards
 * below refuse those addresses, and they are re-checked on every redirect hop,
 * because a public URL is free to redirect to a private one.
 */

export const MAX_PAGE_BYTES = 3_000_000;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 15_000;

/** Carries the status the endpoint should answer with. */
export class PageFetchError extends Error {
  constructor(
    message: string,
    readonly status: number = 502
  ) {
    super(message);
    this.name = 'PageFetchError';
  }
}

/** Names that resolve to the machine itself or to a private network. */
const BLOCKED_HOSTNAMES =
  /^(localhost|ip6-localhost|instance-data|metadata|metadata\.google\.internal|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i;

/**
 * Literal addresses that are not routable on the public internet.
 *
 * Only the written form needs checking for the decimal and octal spellings of
 * an address (`0177.0.0.1`, `2130706433`): the URL parser has already
 * normalised those to dotted quads. IPv6 needs more care — it normalises an
 * IPv4-mapped address to hex, so `::ffff:127.0.0.1` arrives as `::ffff:7f00:1`.
 */
function isPrivateAddress(host: string): boolean {
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((part) => part > 255)) return true;
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  if (host.includes(':')) {
    const v6 = host.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    if (/^f[cd]/.test(v6)) return true; // unique local
    if (/^fe[89ab]/.test(v6)) return true; // link-local

    const dotted = v6.match(/:ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dotted) return isPrivateAddress(dotted[1]);

    const hex = v6.match(/:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      return isPrivateAddress([high >> 8, high & 255, low >> 8, low & 255].join('.'));
    }
    return false;
  }

  return false;
}

/**
 * Validates a URL for fetching, or throws with a message safe to show a user.
 *
 * Note the limit: this checks the address as written. A hostname that resolves
 * to a private IP is not caught, which would need a DNS lookup and a pinned
 * connection. For a personal deployment the trade-off is acceptable; a public
 * one should put an egress proxy in front of this.
 */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new PageFetchError('That does not look like a web address.', 400);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PageFetchError('Only http and https pages can be read.', 400);
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || BLOCKED_HOSTNAMES.test(host) || isPrivateAddress(host)) {
    throw new PageFetchError('That address is not one this server will fetch.', 400);
  }

  return url;
}

export interface FetchedPage {
  html: string;
  /** The address the content actually came from, after any redirects. */
  url: string;
  /** Content type as served, so the caller can pick the right parser. */
  contentType: string;
}

/** Charset from a content-type header, defaulting to UTF-8. */
function charsetOf(contentType: string): string {
  const m = contentType.match(/charset=["']?([\w-]+)/i);
  return m ? m[1] : 'utf-8';
}

/** Reads the body with a hard ceiling, so a huge or endless response cannot fill memory. */
async function readCapped(res: Response, charset: string): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_PAGE_BYTES) throw new PageFetchError('That page is too large to read.');

  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PAGE_BYTES) {
      await reader.cancel();
      throw new PageFetchError('That page is too large to read.');
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder(charset).decode(merged);
  } catch {
    // An unknown charset label is not worth failing the whole read over.
    return new TextDecoder('utf-8').decode(merged);
  }
}

export async function fetchPageHtml(rawUrl: string): Promise<FetchedPage> {
  let target = assertFetchableUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(target, {
        // Redirects are followed by hand so each hop can be validated: a public
        // URL that redirects to 169.254.169.254 must not be followed.
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,text/plain',
          'User-Agent': 'Mozilla/5.0 (compatible; FlashcardForge/1.0; +local study tool)',
          'Accept-Language': 'en',
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new PageFetchError('That page redirected without saying where.');
        target = assertFetchableUrl(new URL(location, target).toString());
        continue;
      }

      if (!res.ok) throw new PageFetchError(`That page returned ${res.status}.`);

      const contentType = res.headers.get('content-type') ?? '';
      if (contentType && !/text\/html|application\/xhtml\+xml|text\/plain|text\/markdown/i.test(contentType)) {
        throw new PageFetchError('That address is not a readable page.', 415);
      }

      return {
        html: await readCapped(res, charsetOf(contentType)),
        url: target.toString(),
        contentType,
      };
    }

    throw new PageFetchError('That page redirected too many times.');
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new PageFetchError('That page took too long to respond.', 504);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
