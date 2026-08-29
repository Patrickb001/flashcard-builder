import type { DocumentSection } from './documentModel';
import { cleanPageTitle, sectionsFromDocument } from './htmlParser';
import { parseMarkdownSections } from './markdownParser';

/**
 * Turns a URL into sections, via the server-side reader.
 *
 * The fetch has to happen on the server (cross-origin rules), but the parsing
 * stays in the browser like every other format — the page's text is never sent
 * anywhere, only its address.
 */

export interface PageResult {
  sections: DocumentSection[];
  /** A readable name for the deck: the page's title, or its address. */
  name: string;
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

/** True for an address that serves Markdown rather than a rendered page. */
function isMarkdownSource(url: string, contentType: string): boolean {
  if (/text\/markdown/i.test(contentType)) return true;
  // A raw file link is served as text/plain, so the extension decides.
  return /text\/plain/i.test(contentType) && /\.(md|markdown|mdown|mkd)(\?|#|$)/i.test(url);
}

export async function fetchPageSections(rawUrl: string): Promise<PageResult> {
  const res = await fetch('/api/fetch-page', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: rawUrl }),
  });

  if (res.status === 404) {
    throw new Error(
      'The /api/fetch-page endpoint was not found. Start the app with `npm run dev` from the project root so the dev server serves it.'
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
    return { sections: parseMarkdownSections(data.html, name.split('/').pop() ?? name), name };
  }

  // Parsed once here rather than inside the parser, so the title is read before
  // the noise strip touches the document.
  const doc = new DOMParser().parseFromString(data.html, 'text/html');
  const title = cleanPageTitle(doc.title ?? '');
  const sections = sectionsFromDocument(doc, { pageTitle: title });

  return { sections, name: title || deckNameForUrl(finalUrl) };
}
