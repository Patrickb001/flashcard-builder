import { fetchPageHtml, PageFetchError } from '../lib/fetchPage';
import type { HandlerResult } from './endpoint';

/**
 * Reads a web page on behalf of the browser.
 *
 * Cross-origin rules stop the app from fetching another site's HTML itself, so
 * this does it server-side and hands back the markup; the parsing still happens
 * in the browser, so a page's text never leaves the reader's machine — only its
 * address is sent.
 *
 * The URL guards live in src/lib/fetchPage.ts, shared by both deployments; this
 * handler is only the HTTP shell around them.
 */

/** Options for handleFetchPage. */
export interface FetchPageOptions {
  /** Where to report a failure; the terminal locally, the log in production. */
  onError?: (message: string) => void;
}

/**
 * Validates the request and hands back the page's markup.
 *
 * Every rejection carries the fetcher's own message, which is written to be
 * read by a person and deliberately reveals nothing about the server's network.
 */
export async function handleFetchPage(
  body: unknown,
  options: FetchPageOptions = {}
): Promise<HandlerResult> {
  const { url } = (body ?? {}) as { url?: unknown };

  if (typeof url !== 'string' || !url.trim()) {
    return { status: 400, body: { error: 'Expected a "url" string.' } };
  }

  try {
    return { status: 200, body: await fetchPageHtml(url) };
  } catch (err) {
    // The fetcher's messages are written to be shown to a person and reveal
    // nothing about the server's own network.
    const message = err instanceof Error ? err.message : 'Could not read that page.';
    options.onError?.(message);
    return { status: err instanceof PageFetchError ? err.status : 502, body: { error: message } };
  }
}
