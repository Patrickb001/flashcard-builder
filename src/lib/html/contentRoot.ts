import { tag, textOf } from './domText';

/**
 * Deciding which part of a page is the article.
 *
 * A page is mostly not content. This is the subtractive half of the parser:
 * throw away the furniture, then pick the element that holds the article.
 *
 * The two lists are ordered deliberately - noise is removed before a root is
 * chosen, and the first specific content candidate wins rather than the
 * largest, because `main` usually contains `article` plus the page chrome.
 */

/** Wrappers that never hold article text. */
const NOISE_TAGS = [
  'script',
  'style',
  'noscript',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'svg',
  'iframe',
  'canvas',
  'template',
  'dialog',
  'button',
  'select',
  'textarea',
  'input',
  'video',
  'audio',
];

/** Landmarks and states that mark a region as chrome. */
const NOISE_SELECTORS = [
  '[aria-hidden="true"]',
  '[hidden]',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
  '[role="search"]',
  '[role="dialog"]',
  '.sidebar',
  '.toc',
  '.breadcrumb',
  '.breadcrumbs',
  '.cookie-banner',
  '.advertisement',
];

/** Where the article usually lives, most specific first. */
const CONTENT_SELECTORS = [
  'article',
  '.mw-parser-output',
  '[role="main"]',
  'main',
  '#content',
  '#main',
  '#main-content',
  '.markdown-body',
  '.post-content',
  '.entry-content',
  '.article-body',
  '.content',
];

/**
 * The element to search for content, or null when there is nothing to descend
 * into — `doc.body` is null on a document parsed from a fragment.
 *
 * `document.body` is preferred, but a document parsed outside a browser (the
 * test harness, a saved page with markup before `<body>`) can report an empty
 * one while the real content hangs off the root, so an empty body is not
 * trusted.
 */
export function contentBody(doc: Document): Element | null {
  const body = doc.body;
  if (body && body.children.length > 0) return body;
  return doc.documentElement ?? body;
}

/** True when any ancestor of `el` is one of `tags`. */
function hasAncestor(el: Element, tags: string[]): boolean {
  let parent = el.parentElement;
  while (parent) {
    if (tags.includes(tag(parent))) return true;
    parent = parent.parentElement;
  }
  return false;
}

/**
 * Removes every element that is chrome rather than content.
 *
 * `header` and `footer` are the exception: sitewide they are chrome, but inside
 * an article they are the byline and the title — dropping those would throw
 * away the page's own H1 on any site that marks it up that way.
 */
export function stripNoise(root: Element): void {
  // One selector per call: comma lists are not supported by every DOM
  // implementation this runs against.
  for (const selector of [...NOISE_TAGS, ...NOISE_SELECTORS]) {
    for (const el of Array.from(root.querySelectorAll(selector))) {
      if ((selector === 'header' || selector === 'footer') && hasAncestor(el, ['article', 'main'])) {
        continue;
      }
      el.remove();
    }
  }
}

/**
 * Picks the element holding the article.
 *
 * The first specific candidate with real text wins, rather than the largest:
 * `main` usually contains `article` plus the page's own furniture, so
 * preferring the outer one would pull the furniture back in.
 */
export function findContentRoot(doc: Document): Element | null {
  const body = contentBody(doc);
  // No element to descend into at all: an empty document, or a fragment
  // with neither a body nor a root element. Previously this threw.
  if (!body) return null;

  for (const selector of CONTENT_SELECTORS) {
    for (const candidate of Array.from(body.querySelectorAll(selector))) {
      if (textOf(candidate).length >= 400) return candidate;
    }
  }
  return body;
}
