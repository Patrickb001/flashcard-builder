import type { Block, DocumentSection, ListBlock, TableBlock } from './documentModel';
import { sectionsFromBlocks, truncateCode } from './sectioning';

/**
 * Reads a web page into structured sections.
 *
 * A page is mostly not content: navigation, breadcrumbs, cookie banners, "was
 * this helpful?" widgets and a table of contents all read as text. Handing the
 * lot to the drafter produces cards about the site's chrome, so the work here
 * is subtractive — find the element that holds the article, throw away the
 * furniture, then map the surviving elements onto blocks.
 *
 * Parsing runs on a document the browser already built (`DOMParser`), so there
 * is no HTML tokenizer here and no dependency to ship.
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

/** A container of these only is a paragraph, not a wrapper to descend into. */
const INLINE_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'br',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'i',
  'img',
  'ins',
  'kbd',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
]);

/** Page controls that survive the structural filters because they read as prose. */
const CHROME_TEXT =
  /^(is this page useful\??|was this (page )?helpful\??|edit (this )?page|previous|next|on this page|table of contents|in this article|share (this)?|copy( link| code)?|skip to (main )?content|back to top|menu|search|subscribe|sign (in|up)|log in|accept( all)?( cookies)?|cookie (policy|settings)|advertisement|loading…?|show more|read more)$/i;

/**
 * Callout labels that documentation sites mark up as headings.
 *
 * "Note" and "Pitfall" title a box inside a section, not a topic of their own.
 * Left at their markup level they would name a section — and the card's topic
 * chip would read "Note" — so they are demoted below the split level.
 */
const CALLOUT_HEADINGS =
  /^(note|notes|pitfall|caution|warning|tip|hint|deep dive|illustrated by|under the hood|remember|example|examples|try it out)$/i;

const MIN_BLOCK_CHARS = 3;

function tag(el: Element): string {
  return el.tagName.toLowerCase();
}

/** Node types worth reading: elements and text. Comments are not text. */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * Collapsed text of an element.
 *
 * Child text is joined with a space rather than read straight off
 * `textContent`, because sites lay out separate elements that carry no
 * whitespace between them: a heading badge and its title run together as
 * "Deep DiveHow does React know...". The space is then taken back off in front
 * of punctuation, so inline `<code>` inside a sentence still reads correctly.
 *
 * Comment nodes are skipped explicitly. Template libraries leave marker
 * comments in the markup, and reading them turned MDN's headings into
 * "lit-node 1 Lexical scoping".
 */
function textOf(el: Element | null): string {
  if (!el) return '';
  let text = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === ELEMENT_NODE) text += ` ${textOf(node as Element)} `;
    else if (node.nodeType === TEXT_NODE) text += node.textContent ?? '';
  }
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?%)\]}])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .trim()
    .replace(/\s*[#¶]\s*$/, '');
}

/**
 * True when a block is nothing but links — a pager, a breadcrumb trail, or a
 * "see also" row. One link inside a sentence is ordinary prose, so the test is
 * about how much of the text is link text, not whether links are present.
 */
function isLinkRow(el: Element): boolean {
  const links = Array.from(el.querySelectorAll('a'));
  if (links.length < 2) return false;
  const linkChars = links.reduce((n, a) => n + textOf(a).length, 0);
  const total = textOf(el).length;
  return total > 0 && linkChars >= total * 0.9;
}

function isChrome(text: string): boolean {
  return text.length < MIN_BLOCK_CHARS || CHROME_TEXT.test(text);
}

// ---------------------------------------------------------------------------
// Choosing what to read
// ---------------------------------------------------------------------------

/**
 * The element to search for content.
 *
 * `document.body` is preferred, but a document parsed outside a browser (the
 * test harness, a saved page with markup before `<body>`) can report an empty
 * one while the real content hangs off the root, so an empty body is not
 * trusted.
 */
function contentBody(doc: Document): Element {
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
function stripNoise(root: Element): void {
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
export function findContentRoot(doc: Document): Element {
  const body = contentBody(doc);
  for (const selector of CONTENT_SELECTORS) {
    for (const candidate of Array.from(body.querySelectorAll(selector))) {
      if (textOf(candidate).length >= 400) return candidate;
    }
  }
  return body;
}

// ---------------------------------------------------------------------------
// Element → block
// ---------------------------------------------------------------------------

/** Language names worth recording, as they appear in class names. */
const CODE_LANGUAGES = new Set([
  'bash', 'c', 'cpp', 'csharp', 'css', 'dart', 'diff', 'go', 'graphql', 'html', 'java',
  'javascript', 'js', 'json', 'jsx', 'kotlin', 'markdown', 'md', 'php', 'python', 'py',
  'ruby', 'rust', 'scala', 'scss', 'sh', 'shell', 'sql', 'swift', 'ts', 'tsx',
  'typescript', 'xml', 'yaml', 'yml',
]);

/**
 * The language of a snippet, from whatever convention the site uses:
 * `language-js`, `lang-ts`, `sp-javascript`, or a data attribute.
 */
function codeLanguage(pre: Element): string | undefined {
  const code = pre.querySelector('code');
  const declared =
    pre.getAttribute('data-language') ??
    pre.getAttribute('data-lang') ??
    code?.getAttribute('data-language') ??
    null;
  if (declared && CODE_LANGUAGES.has(declared.toLowerCase())) return declared.toLowerCase();

  const classes = `${pre.getAttribute('class') ?? ''} ${code?.getAttribute('class') ?? ''}`;
  for (const token of classes.toLowerCase().split(/[\s-]+/)) {
    if (CODE_LANGUAGES.has(token)) return token;
  }
  return undefined;
}

/**
 * Text of a snippet, with its line breaks.
 *
 * Editors and highlighters render each line as its own element, and reading
 * `textContent` off the parent would run every line together into one
 * unreadable string. Leaf line elements are joined back with newlines.
 */
function codeText(pre: Element): string {
  const lineNodes = Array.from(pre.querySelectorAll('div')).filter(
    (d) => d.querySelectorAll('div').length === 0
  );
  const raw =
    lineNodes.length > 1
      ? lineNodes.map((d) => d.textContent ?? '').join('\n')
      : (pre.textContent ?? '');
  return raw.replace(/\u00a0/g, ' ').replace(/[ \t]+$/gm, '').trim();
}

/** Text of one list item, excluding any list nested inside it. */
function itemText(li: Element): string {
  let text = '';
  for (const node of Array.from(li.childNodes)) {
    if (node.nodeType === ELEMENT_NODE) {
      const el = node as Element;
      if (tag(el) === 'ul' || tag(el) === 'ol') continue;
      text += ` ${textOf(el)} `;
    } else if (node.nodeType === TEXT_NODE) {
      text += node.textContent ?? '';
    }
  }
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?%)\]}])/g, '$1')
    .trim();
}

/** Flattens a list, nested items included, the way the Markdown reader does. */
function listItems(list: Element): string[] {
  const items: string[] = [];
  for (const li of Array.from(list.children)) {
    if (tag(li) !== 'li') continue;
    const own = itemText(li);
    if (own && !isChrome(own)) items.push(own);
    for (const nested of Array.from(li.children)) {
      if (tag(nested) === 'ul' || tag(nested) === 'ol') items.push(...listItems(nested));
    }
  }
  return items;
}

function rowCells(row: Element): string[] {
  return Array.from(row.children)
    .filter((c) => tag(c) === 'td' || tag(c) === 'th')
    .map((c) => textOf(c));
}

function parseTable(table: Element): Block[] {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows.length < 2) return [];

  const grid = rows.map(rowCells).filter((cells) => cells.length > 0);
  const [headers, ...body] = grid;

  if (!headers || headers.length < 2 || body.length === 0 || headers.some((h) => !h)) {
    // Not a usable header row — keep the text rather than dropping the table.
    return grid
      .map((cells) => cells.filter(Boolean).join(' — '))
      .filter((text) => !isChrome(text))
      .map((text) => ({ kind: 'paragraph', text }) as Block);
  }

  const width = headers.length;
  const normalized = body.map((cells) => {
    const padded = [...cells];
    while (padded.length < width) padded.push('');
    return padded.slice(0, width);
  });

  return [{ kind: 'table', headers, rows: normalized } as TableBlock];
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

/**
 * Text sitting directly inside a wrapper, outside any child element.
 *
 * `<div>Some intro text<ul>…</ul></div>` is common enough to matter: descending
 * straight to the list would lose the sentence introducing it.
 */
function looseText(el: Element): string {
  let text = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === TEXT_NODE) text += node.textContent ?? '';
  }
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** True when an element holds only text and inline markup. */
function isTextContainer(el: Element): boolean {
  return Array.from(el.children).every((child) => INLINE_TAGS.has(tag(child)));
}

function walk(el: Element, blocks: Block[]): void {
  for (const child of Array.from(el.children)) {
    const name = tag(child);

    if (/^h[1-6]$/.test(name)) {
      const text = textOf(child);
      if (text && !isChrome(text)) {
        const level = CALLOUT_HEADINGS.test(text) ? 5 : Number(name[1]);
        blocks.push({ kind: 'heading', text, level });
      }
      continue;
    }

    if (name === 'pre') {
      const text = codeText(child);
      if (text.length >= MIN_BLOCK_CHARS) {
        blocks.push({ kind: 'code', language: codeLanguage(child), text: truncateCode(text) });
      }
      continue;
    }

    if (name === 'ul' || name === 'ol') {
      if (isLinkRow(child)) continue;
      const items = listItems(child);
      if (items.length > 0) blocks.push({ kind: 'list', items } as ListBlock);
      continue;
    }

    if (name === 'dl') {
      const items: string[] = [];
      let term = '';
      for (const node of Array.from(child.children)) {
        if (tag(node) === 'dt') term = textOf(node);
        else if (tag(node) === 'dd') {
          const definition = textOf(node);
          if (definition) items.push(term ? `${term}: ${definition}` : definition);
        }
      }
      if (items.length > 0) blocks.push({ kind: 'list', items } as ListBlock);
      continue;
    }

    if (name === 'table') {
      blocks.push(...parseTable(child));
      continue;
    }

    if (name === 'details') {
      // A collapsed "deep dive" is content; its summary is the label for it.
      const summary = child.querySelector('summary');
      const label = textOf(summary);
      if (label && !isChrome(label)) blocks.push({ kind: 'heading', text: label, level: 5 });
      summary?.remove();
      walk(child, blocks);
      continue;
    }

    if (name === 'p' || name === 'figcaption' || name === 'blockquote' || isTextContainer(child)) {
      // A blockquote of several paragraphs still descends; a one-line one does
      // not need to.
      if (name === 'blockquote' && !isTextContainer(child)) {
        walk(child, blocks);
        continue;
      }
      const text = textOf(child);
      if (text && !isChrome(text) && !isLinkRow(child)) {
        blocks.push({ kind: 'paragraph', text });
      }
      continue;
    }

    // A wrapper can carry a sentence of its own before its block children.
    const loose = looseText(child);
    if (loose.length >= 40 && !isChrome(loose)) blocks.push({ kind: 'paragraph', text: loose });
    walk(child, blocks);
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Headings that open an appendix rather than content.
 *
 * An encyclopedia article ends in several screens of citations, link lists and
 * navigation boxes. They read as prose and would otherwise become sections —
 * and cards asking what reference 47 is.
 */
const APPENDIX_HEADINGS =
  /^(references?|citations?|notes( and references)?|footnotes?|bibliography|sources|further reading|external links?|see also|related (articles?|topics?|pages?|links?)|navigation menu|contents|comments?|share this|about the author|licen[cs]e|acknowledgements?)$/i;

/**
 * Drops each appendix heading and everything under it, up to the next heading
 * at the same depth or shallower.
 */
function dropAppendices(blocks: Block[]): Block[] {
  const kept: Block[] = [];
  let skippingBelow: number | null = null;

  for (const block of blocks) {
    if (block.kind === 'heading') {
      if (skippingBelow !== null && block.level <= skippingBelow) skippingBelow = null;
      if (skippingBelow === null && APPENDIX_HEADINGS.test(block.text)) {
        skippingBelow = block.level;
        continue;
      }
    }
    if (skippingBelow === null) kept.push(block);
  }

  return kept;
}

/**
 * Drops the breadcrumb trail.
 *
 * Anything before the page's first heading that is only a few words long is a
 * trail of section names ("Learn React", "Adding Interactivity"), not prose.
 * Left in, it becomes a section of its own with nothing in it worth learning.
 */
function dropLeadingCrumbs(blocks: Block[]): Block[] {
  const firstHeading = blocks.findIndex((b) => b.kind === 'heading');
  if (firstHeading <= 0) return blocks;
  const lead = blocks.slice(0, firstHeading);
  const allCrumbs = lead.every((b) => b.kind === 'paragraph' && b.text.length <= 60);
  return allCrumbs ? blocks.slice(firstHeading) : blocks;
}

/** "State: A Component's Memory – React" -> "State: A Component's Memory". */
export function cleanPageTitle(title: string): string {
  const trimmed = title.replace(/\s+/g, ' ').trim();
  const m = trimmed.match(/^(.{8,}?)\s+[–—|·»-]\s+(.{2,40})$/);
  return m ? m[1].trim() : trimmed;
}

export interface HtmlParseOptions {
  /** Used as the topic label when the page has no headings of its own. */
  pageTitle?: string;
}

/** Reads an already-parsed document. Kept separate so it can be tested in Node. */
export function sectionsFromDocument(
  doc: Document,
  options: HtmlParseOptions = {}
): DocumentSection[] {
  const body = contentBody(doc);
  if (body) stripNoise(body);

  const root = findContentRoot(doc);
  const blocks: Block[] = [];
  walk(root, blocks);

  const title = cleanPageTitle(options.pageTitle ?? doc.title ?? '');
  return sectionsFromBlocks(dropAppendices(dropLeadingCrumbs(blocks)), {
    fallbackTitle: title || undefined,
  });
}

export function parseHtmlSections(html: string, options: HtmlParseOptions = {}): DocumentSection[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return sectionsFromDocument(doc, options);
}

export async function extractHtmlSections(file: File): Promise<DocumentSection[]> {
  return parseHtmlSections(await file.text(), {
    pageTitle: file.name.replace(/\.(html?|xhtml)$/i, ''),
  });
}
