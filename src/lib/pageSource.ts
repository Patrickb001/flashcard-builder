import type { DocumentSection } from './documentModel';
import { cleanPageTitle, sectionsFromDocument } from './htmlParser';
import { parseMarkdownSections } from './markdownParser';

/**
 * Turns one or more URLs into sections, via the server-side reader.
 *
 * The fetch has to happen on the server (cross-origin rules), but the parsing
 * stays in the browser like every other format — the pages' text is never sent
 * anywhere, only their addresses.
 */

/** More than this in one go is a scrape, not a study session. */
export const MAX_PAGES = 10;

/**
 * The reader endpoint itself is missing.
 *
 * Distinct from a page that failed: trying the remaining addresses cannot
 * help, and reporting the same setup error once per address would bury it.
 */
export class PageReaderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageReaderUnavailableError';
  }
}

export interface PageResult {
  sections: DocumentSection[];
  /** A readable name for the deck: the page's title, or its address. */
  name: string;
  /** Where the content actually came from, after redirects. */
  url: string;
}

export interface PageFailure {
  url: string;
  error: string;
}

export interface MultiPageResult {
  sections: DocumentSection[];
  name: string;
  /** Pages that could not be read; the rest still went through. */
  failures: PageFailure[];
  /** How many pages contributed sections. */
  pages: number;
}

/** "https://18.react.dev/learn/state" -> "18.react.dev/learn/state". */
export function deckNameForUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.hostname}${url.pathname}`.replace(/\/$/, '') || url.hostname;
  } catch {
    return rawUrl;
  }
}

/** Comparable form of an address, so the same page is not read twice. */
function urlKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.host}${url.pathname.replace(/\/$/, '')}${url.search}`.toLowerCase();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

/**
 * A piece that can be read as a bare host, e.g. "react.dev/learn".
 *
 * Without this test every word in a pasted sentence becomes an address:
 * "[State](https://…) and [Render](https://…)" turned "and" into
 * "https://and". A host needs a dot and a plausible suffix.
 */
const LOOKS_LIKE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#]|$)/i;

/**
 * Splits pasted text into addresses.
 *
 * People paste a list however they have it — one per line, or several run
 * together — and often without a scheme, so "react.dev/learn" is assumed to be
 * https. Splitting is on whitespace, plus a comma or semicolon that is followed
 * by another address: a bare comma cannot be a separator, because query strings
 * are full of them (`?fields=a,b`). Duplicates are dropped, since the same page
 * twice would only produce the same cards twice.
 */
export function parseUrlList(raw: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  const pieces = raw
    .split(/\s+/)
    .flatMap((piece) => piece.split(/[,;](?=https?:\/\/)/))
    .flatMap((piece) => piece.split(/[,;](?=www\.)/))
    // Markdown links pasted with nothing between them are one piece, and the
    // strip below reads to the last "](" it can find - so every address but
    // the final one was silently dropped.
    .flatMap((piece) => piece.split(/(?<=\))(?=\[)/));

  for (const piece of pieces) {
    const trimmed = piece
      .trim()
      // Addresses arrive wrapped in Markdown link syntax or angle brackets.
      .replace(/^[<([]+/, '')
      .replace(/^.*?\]\(/, '')
      .replace(/[>)\]]+$/, '')
      .replace(/[.,;]+$/, '');
    if (!trimmed) continue;

    // A word from a pasted sentence is not an address.
    const hasScheme = /^https?:\/\//i.test(trimmed);
    if (!hasScheme && !LOOKS_LIKE_HOST.test(trimmed)) continue;

    const withScheme = hasScheme ? trimmed : `https://${trimmed}`;
    const key = urlKey(withScheme);
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(withScheme);
  }

  return urls;
}

/** True for an address that serves Markdown rather than a rendered page. */
function isMarkdownSource(url: string, contentType: string): boolean {
  if (/text\/markdown/i.test(contentType)) return true;
  // A raw file link is served as text/plain, so the extension decides.
  return /text\/plain/i.test(contentType) && /\.(md|markdown|mdown|mkd)(\?|#|$)/i.test(url);
}

async function fetchPageSections(rawUrl: string): Promise<PageResult> {
  // This request goes to the app's own origin, so a network-level failure is
  // never the target site's fault — it means the reader itself is unreachable.
  let res: Response;
  try {
    res = await fetch('/api/fetch-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: rawUrl }),
    });
  } catch {
    throw new PageReaderUnavailableError(
      'Could not reach the page reader. If you are running locally, start the app with `npm run dev` from the project root.'
    );
  }

  // A JSON body is the sign that the reader actually answered. A 404, or the
  // single-page-app fallback serving index.html with a 200, both mean the
  // endpoint is not there — a setup problem rather than a bad address.
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  if (res.status === 404 || !isJson) {
    throw new PageReaderUnavailableError(
      'The /api/fetch-page endpoint did not answer. Start the app with `npm run dev` from the project root so the dev server serves it.'
    );
  }

  const data: { html?: string; url?: string; contentType?: string; error?: string } = await res
    .json()
    .catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Could not read that page (${res.status}).`);
  if (!data.html) throw new Error('That page came back empty.');

  const finalUrl = data.url ?? rawUrl;

  // A raw README is Markdown, not a page; running it through the HTML reader
  // would flatten every heading into one paragraph.
  if (isMarkdownSource(finalUrl, data.contentType ?? '')) {
    const name = deckNameForUrl(finalUrl);
    return {
      sections: parseMarkdownSections(data.html, name.split('/').pop() ?? name),
      name,
      url: finalUrl,
    };
  }

  // Parsed once here rather than inside the parser, so the title is read before
  // the noise strip touches the document.
  const doc = new DOMParser().parseFromString(data.html, 'text/html');
  const title = cleanPageTitle(doc.title);
  // The address after redirects, so a diagram referenced by a relative path
  // resolves against the site it came from rather than against this app.
  const sections = sectionsFromDocument(doc, { pageTitle: title, baseUrl: finalUrl });

  return { sections, name: title || deckNameForUrl(finalUrl), url: finalUrl };
}

/** Keeps a source label short enough to sit on a card. */
function shorten(name: string, max = 34): string {
  return name.length > max ? `${name.slice(0, max - 1).trimEnd()}…` : name;
}

/**
 * Re-labels one page's sections for a deck built from several pages.
 *
 * "Section 3" is enough when a deck comes from one document. Across pages the
 * card has to say which page it came from. `group` is the page's address rather
 * than its name, because two pages can share a title ("Introduction") and the
 * group is what keeps the drafter from mixing them into one request — see the
 * batching in aiGenerator.
 */
function labelForDeck(page: PageResult): DocumentSection[] {
  return page.sections.map((section, i) => ({
    ...section,
    label: `${shorten(page.name)} §${i + 1}`,
    group: page.url,
  }));
}

export interface PageProgress {
  done: number;
  total: number;
  url: string;
}

/**
 * Reads several pages into one deck.
 *
 * Pages are fetched one at a time on purpose: the reader is rate-limited, and a
 * burst of parallel requests to the same site is rude. A page that fails does
 * not sink the batch — it is reported and the rest go through.
 */
export async function fetchPagesSections(
  urls: string[],
  onProgress?: (p: PageProgress) => void
): Promise<MultiPageResult> {
  const wanted = urls.slice(0, MAX_PAGES);
  const sections: DocumentSection[] = [];
  const names: string[] = [];
  // Anything over the limit is reported rather than dropped in silence.
  const failures: PageFailure[] = urls.slice(MAX_PAGES).map((url) => ({
    url,
    error: `Over the ${MAX_PAGES}-page limit for one deck.`,
  }));
  const readKeys = new Set(wanted.map(urlKey));

  for (let i = 0; i < wanted.length; i++) {
    const url = wanted[i];
    onProgress?.({ done: i, total: wanted.length, url });

    try {
      const page = await fetchPageSections(url);

      // Two addresses can redirect to the same place; reading it twice would
      // duplicate every card from it.
      const finalKey = urlKey(page.url);
      if (finalKey !== urlKey(url) && readKeys.has(finalKey)) {
        failures.push({ url, error: 'Redirects to another address in this list.' });
        continue;
      }
      readKeys.add(finalKey);

      if (page.sections.length === 0) {
        failures.push({
          url,
          error: 'No readable article text — a page that builds itself in the browser cannot be read this way.',
        });
        continue;
      }

      names.push(page.name);
      sections.push(...(wanted.length > 1 ? labelForDeck(page) : page.sections));
    } catch (err) {
      // A missing reader endpoint is a setup problem, not a bad address:
      // the remaining pages would all fail the same way.
      if (err instanceof PageReaderUnavailableError) throw err;
      failures.push({ url, error: err instanceof Error ? err.message : 'Could not read that page.' });
    }
  }

  onProgress?.({ done: wanted.length, total: wanted.length, url: '' });

  const name =
    names.length === 0
      ? ''
      : names.length === 1
        ? names[0]
        : `${shorten(names[0], 40)} + ${names.length - 1} more`;

  return { sections, name, failures, pages: names.length };
}

/** One line summarising what was skipped, short enough to read at a glance. */
export function describeFailures(failures: PageFailure[], read: number): string {
  const shown = failures.slice(0, 3).map((f) => `${deckNameForUrl(f.url)} — ${f.error}`);
  const rest = failures.length - shown.length;
  const tail = rest > 0 ? `; and ${rest} more` : '';
  return `Read ${read} of ${read + failures.length} pages. Skipped: ${shown.join('; ')}${tail}`;
}
