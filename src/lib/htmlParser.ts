import type {
  Block,
  CodeBlock,
  DocumentSection,
  ImageBlock,
  ListBlock,
  TableBlock,
} from './documentModel';
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
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn',
  'em', 'i', 'img', 'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span',
  'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
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

/** Collapses the whitespace a page's markup leaves between inline elements. */
function tidyInline(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?%)\]}])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .trim();
}

/**
 * Whether an element boundary needs a space to keep two words apart.
 *
 * Sites lay out separate elements that carry no whitespace between them: a
 * heading badge and its title run together as "Deep DiveHow does React know".
 * But a space added at every boundary breaks the opposite case, and that one is
 * just as common — an editor that bolds a single letter leaves
 * `The <b>i</b>f-else statement`, which came back as "The i f-else statement".
 *
 * The two are told apart by what sits on either side of the join. Words run
 * together across a boundary show a case change; a word split in half does not.
 */
function needsSpace(before: string, after: string): boolean {
  if (!before || !after) return false;
  const left = before[before.length - 1];
  const right = after[0];
  if (/\s/.test(left) || /\s/.test(right)) return false;
  return /[a-z0-9,.:;?!)"']/.test(left) && /[A-Z(]/.test(right);
}

/**
 * Concatenates the text of a run of nodes.
 *
 * Descends by recursion rather than by calling textOf, because textOf trims:
 * the trailing space in `<span>The </span><b>i</b><span>f-else</span>` is the
 * only thing keeping "The" off the word after it, and trimming each child
 * before joining them turned that into "Theif-else".
 *
 * `skip` leaves out children the caller reads separately — a nested list inside
 * a list item, for instance, which its own rule will flatten.
 */
function joinNodes(nodes: ChildNode[], skip?: (child: Element) => boolean): string {
  let text = '';
  for (const node of nodes) {
    if (node.nodeType === ELEMENT_NODE) {
      const child = node as Element;
      if (skip?.(child)) continue;
      const inner = joinNodes(Array.from(child.childNodes), skip);
      if (!inner) continue;
      text += needsSpace(text, inner) ? ` ${inner}` : inner;
    } else if (node.nodeType === TEXT_NODE) {
      const raw = node.textContent ?? '';
      text += needsSpace(text, raw) ? ` ${raw}` : raw;
    }
  }
  return text;
}

/**
 * Collapsed text of an element.
 *
 * Whitespace inside the markup is trusted, and a space is added only where two
 * words would otherwise run together — see needsSpace. The space is then taken
 * back off in front of punctuation, so inline `<code>` inside a sentence still
 * reads correctly.
 *
 * Comment nodes are skipped explicitly. Template libraries leave marker
 * comments in the markup, and reading them turned MDN's headings into
 * "lit-node 1 Lexical scoping".
 */
function textOf(el: Element | null): string {
  if (!el) return '';
  return tidyInline(joinNodes(Array.from(el.childNodes))).replace(/\s*[#¶]\s*$/, '');
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
// Returns null when the document has no element to descend into. The
// signature said Element, but the ?? fallback below and every caller
// already treated the result as possibly absent - doc.body is null on a
// document parsed from a fragment.
function contentBody(doc: Document): Element | null {
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
function findContentRoot(doc: Document): Element | null {
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

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

/** Language names worth recording, as they appear in class names. */
const CODE_LANGUAGES = new Set([
  'bash', 'c', 'cpp', 'cs', 'csharp', 'css', 'dart', 'diff', 'go', 'graphql', 'html', 'java',
  'javascript', 'js', 'json', 'jsx', 'kotlin', 'markdown', 'md', 'php', 'python', 'py',
  'ruby', 'rust', 'scala', 'scss', 'sh', 'shell', 'sql', 'swift', 'ts', 'tsx',
  'typescript', 'xml', 'yaml', 'yml',
]);

/** Attributes a site may use to declare a snippet's language. */
const LANGUAGE_ATTRS = ['data-code-lang', 'data-language', 'data-lang'];

/** A language declared on one element, by attribute or by class name. */
function declaredLanguage(el: Element): string | undefined {
  for (const attr of LANGUAGE_ATTRS) {
    const value = el.getAttribute(attr);
    const named = value ? normalizeLanguage(value) : '';
    if (named && CODE_LANGUAGES.has(named)) return named;
  }
  for (const token of (el.getAttribute('class') ?? '').toLowerCase().split(/[\s-]+/)) {
    const named = normalizeLanguage(token);
    if (CODE_LANGUAGES.has(named)) return named;
  }
  return undefined;
}

/**
 * The language of a snippet, from whatever convention the site uses.
 *
 * Sites declare it in three different places — on the `<pre>` itself
 * (`class="language-js"`), on the `<code>` inside it, or on a wrapper around
 * it. GeeksforGeeks uses the third: neither the `<pre>` nor its highlight
 * `<div>` names a language, and the tab panel above them carries
 * `data-code-lang`. So the search runs downward and then a short way up.
 */
function codeLanguage(pre: Element): string | undefined {
  const own = declaredLanguage(pre);
  if (own) return own;

  const code = pre.querySelector('code');
  if (code) {
    const inner = declaredLanguage(code);
    if (inner) return inner;
  }

  // Bounded, so a language class on some unrelated page wrapper is never read
  // as this snippet's language.
  let parent = pre.parentElement;
  for (let depth = 0; parent && depth < 3; depth++) {
    const above = declaredLanguage(parent);
    if (above) return above;
    parent = parent.parentElement;
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

/** Spellings a site may use for a language that has a canonical name here. */
const LANGUAGE_ALIASES: Record<string, string> = {
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  js: 'javascript',
  py: 'python',
  python3: 'python',
  ts: 'typescript',
};

function normalizeLanguage(raw: string): string {
  const name = raw.trim().toLowerCase();
  return LANGUAGE_ALIASES[name] ?? name;
}

/** True when an element is a tab's label rather than one of its panels. */
function isTabLabel(el: Element): boolean {
  for (const selector of ['pre', 'img', 'table', 'ul', 'ol']) {
    if (el.querySelector(selector)) return false;
  }
  return textOf(el).length <= 40;
}

/**
 * The panels of a code tab strip, in the order the page lists them.
 *
 * Tutorial sites publish the same example several times over — C++, C, Java,
 * Python, C#, JavaScript — behind a row of tabs. A reader sees one of them; all
 * six sit in the markup, so a parser that simply walks the DOM emits six
 * snippets where the page shows one. That inflated the drafting payload
 * sixfold and produced six near-identical cards for a single idea.
 *
 * A strip is recognised structurally rather than by class name: every child is
 * either a panel declaring its own language or a short tab label. Demanding
 * that of *every* child is what stops an ordinary section wrapper that happens
 * to contain one snippet from being taken for a strip and having the rest of
 * its content skipped.
 */
function languageTabPanels(el: Element): { language: string; pre: Element }[] | null {
  const children = Array.from(el.children);
  if (children.length === 0) return null;

  // Cheap test first. This runs on every wrapper the walk descends through, and
  // the full test searches each child's subtree for a <pre> — on a long page
  // that is a scan of the document per wrapper. A strip always declares a
  // language on one of its panels, so an element with none is not one.
  const declaresLanguage = children.some((child) =>
    LANGUAGE_ATTRS.some((attr) => child.getAttribute(attr))
  );
  if (!declaresLanguage) return null;

  const panels: { language: string; pre: Element }[] = [];
  for (const child of children) {
    const declared = LANGUAGE_ATTRS.map((attr) => child.getAttribute(attr)).find(Boolean);
    const pre = child.querySelector('pre');
    if (declared && pre) {
      panels.push({ language: normalizeLanguage(declared), pre });
      continue;
    }
    if (isTabLabel(child)) continue;
    return null;
  }

  if (panels.length === 0) return null;
  // One program shown several ways, or several different programs that happen
  // to sit side by side? Languages being distinct throughout is what tells the
  // two apart: a repeat means these panels are not alternates of each other.
  const languages = new Set(panels.map((p) => p.language));
  return languages.size === panels.length ? panels : null;
}


// ---------------------------------------------------------------------------
// Lists and tables
// ---------------------------------------------------------------------------

/** Text of one list item, excluding any list nested inside it. */
function ownText(li: Element): string {
  return tidyInline(
    joinNodes(Array.from(li.childNodes), (child) => tag(child) === 'ul' || tag(child) === 'ol')
  );
}

/**
 * Text of one list item, with a bolded lead-in restored as a term.
 *
 * Sites bold the term and leave the colon out of the markup, so
 * `<li><b>Iterable</b> the collection the loop goes through</li>` reads as one
 * run-on clause once the tags are gone. Putting the colon back is what lets the
 * card generator see a term and its definition instead of a sentence.
 */
function itemText(li: Element): string {
  const lead = boldLead(li);
  if (lead && lead.rest.length >= 15 && lead.label.split(/\s+/).length <= 6) {
    const term = lead.label.replace(/[:\s]+$/, '');
    if (term) return `${term}: ${lead.rest}`;
  }
  return ownText(li);
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
// Images
// ---------------------------------------------------------------------------

/**
 * File names that mark an image as furniture.
 *
 * Tested against the file name rather than the whole address, because a CDN
 * path routinely contains a word like "banner" in a directory that has nothing
 * to do with the picture itself.
 */
const ICON_NAMES =
  /(^|[/_.-])(logos?|icons?|sprite|avatar|profile|badge|spinner|loader|pixel|beacon|tracking|ads?|advert|banner|thumb|placeholder|emoji|flag|arrow|chevron|caret|star|share|bullet|divider|separator)([/_.-]|$)/i;

/** Alt text that describes a control rather than a picture. */
const ICON_ALT =
  /^(logo|icon|search( icon)?|menu|close|arrow|location|share|image|picture|photo|banner|ad|advertisement|avatar|profile|user|star|rating|thumbnail|placeholder|loading)$/i;

/** Below this an image is a spacer or a bullet, not a diagram. */
const MIN_IMAGE_PX = 100;

/** An inline data URI larger than this is not worth carrying on every card. */
const MAX_DATA_URI_CHARS = 200_000;

/** A dimension attribute, when it is a plain number rather than "inherit" or "100%". */
function pixelAttr(img: Element, name: string): number | null {
  const m = (img.getAttribute(name) ?? '').trim().match(/^(\d+)(px)?$/i);
  return m ? Number(m[1]) : null;
}

/** The address an image loads from, lazy-loading attributes included. */
function imageSource(img: Element): string | null {
  for (const attr of ['src', 'data-src', 'data-original', 'data-lazy-src']) {
    const value = (img.getAttribute(attr) ?? '').trim();
    if (value) return value;
  }
  // A srcset-only image: its first candidate is enough to identify it.
  const first = (img.getAttribute('srcset') ?? '').trim().split(',')[0]?.trim().split(/\s+/)[0];
  return first || null;
}

/**
 * An image block, or null when the image is furniture.
 *
 * The address is made absolute here. A card outlives the page it was drafted
 * from and is stored on its own, so a relative path would later resolve against
 * the app's own origin and load nothing — which is why an image with no usable
 * base is dropped rather than kept and left broken.
 */
function imageBlock(img: Element, baseUrl?: string): ImageBlock | null {
  const raw = imageSource(img);
  if (!raw) return null;

  const alt = (img.getAttribute('alt') ?? '').replace(/\s+/g, ' ').trim();
  if (ICON_ALT.test(alt)) return null;

  // Only a declared size counts. "inherit" and "100%" say nothing about how big
  // the picture actually is, and pixelAttr reports those as unknown.
  const width = pixelAttr(img, 'width');
  const height = pixelAttr(img, 'height');
  if ((width !== null && width < MIN_IMAGE_PX) || (height !== null && height < MIN_IMAGE_PX)) {
    return null;
  }

  let src: string;
  if (/^data:/i.test(raw)) {
    if (!/^data:image\//i.test(raw) || raw.length > MAX_DATA_URI_CHARS) return null;
    src = raw;
  } else {
    let resolved: URL;
    try {
      resolved = new URL(raw, baseUrl);
    } catch {
      return null;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    if (ICON_NAMES.test(resolved.pathname)) return null;
    src = resolved.toString();
  }

  return { kind: 'image', src, alt: alt || undefined };
}

/** Pushes every content image inside an inline container, in document order. */
function pushImages(el: Element, blocks: Block[], baseUrl?: string): void {
  for (const img of Array.from(el.querySelectorAll('img'))) {
    const block = imageBlock(img, baseUrl);
    if (block) blocks.push(block);
  }
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

/**
 * True when an element holds only text and inline markup.
 *
 * The whole subtree is tested, not just the immediate children. `<code>` is an
 * inline tag, but a `<code>` wrapping a `<pre>` is how several sites mark up a
 * code panel — and treating such a panel as a paragraph read the program as
 * prose, collapsing its newlines and spacing its punctuation out into
 * "System. out. print".
 */
function isTextContainer(el: Element): boolean {
  for (const child of Array.from(el.children)) {
    if (!INLINE_TAGS.has(tag(child))) return false;
    if (!isTextContainer(child)) return false;
  }
  return true;
}

const LABEL_TAGS = new Set(['b', 'strong']);

/** A list marker an editor left outside the bold run: "1. ", "(2) ". */
const ORDINAL_LEAD = /^\s*\(?\d{1,2}[.)]\s*$/;

/**
 * A bolded lead-in and whatever text follows it.
 *
 * Documentation written in a visual editor has no heading markup below H3;
 * authors bold a line instead. Both shapes matter: a wholly bold line is a
 * subheading, and a bold label followed by prose ("Explanation: the code
 * initialises…") is a labelled paragraph. Read as plain paragraphs they leave a
 * whole article as one undivided section with nothing to hang a question on —
 * GeeksforGeeks marks up two or three real headings per page and writes every
 * remaining subtopic this way.
 *
 * The numbering of a numbered subheading is as likely to sit outside the bold
 * run as inside it, so a marker before the label is stepped over rather than
 * taken for the start of the prose.
 */
function boldLead(el: Element): { label: string; rest: string } | null {
  const nodes = Array.from(el.childNodes);
  let i = 0;
  let label = '';

  while (i < nodes.length) {
    const node = nodes[i];

    if (node.nodeType === TEXT_NODE) {
      const raw = node.textContent ?? '';
      if (!raw.trim() || (!label && ORDINAL_LEAD.test(raw))) {
        i += 1;
        continue;
      }
      break;
    }

    if (node.nodeType !== ELEMENT_NODE) break;
    const child = node as Element;

    if (LABEL_TAGS.has(tag(child))) {
      label += ` ${textOf(child)} `;
      i += 1;
      continue;
    }

    // A marker wrapped in a span of its own: "<span>1. </span><b>…</b>".
    if (!label && ORDINAL_LEAD.test(textOf(child))) {
      i += 1;
      continue;
    }

    break;
  }

  label = tidyInline(label);
  if (!label) return null;

  const trimmed = tidyInline(joinNodes(nodes.slice(i)));

  // Editors put the colon outside the bold run as often as inside it —
  // "<b>Nested Ternary Condition</b>: a ternary inside another". Moving it onto
  // the label is what makes the two spellings behave the same.
  if (trimmed.startsWith(':')) {
    return { label: `${label}:`, rest: trimmed.slice(1).trim() };
  }
  return { label, rest: trimmed };
}

/**
 * True when a wholly bold line is standing in for a heading.
 *
 * A bold sentence is emphasis; a bold phrase alone on its line is a subheading.
 * Length and final punctuation are what tell the two apart.
 */
function isPseudoHeading(label: string): boolean {
  if (label.length < 3 || label.length > 80) return false;
  if (label.split(/\s+/).length > 12) return false;
  return !/[.!?]$/.test(label);
}

/**
 * A paragraph, split into its bolded label and its prose when it has both.
 *
 * The colon is the deciding signal. Without one, a bold run at the start of a
 * sentence is ordinary emphasis, and lifting it out would leave the rest of the
 * sentence as a headless fragment.
 */
function paragraphBlock(el: Element): Block | null {
  const lead = boldLead(el);

  if (lead && !lead.rest && isPseudoHeading(lead.label)) {
    const text = lead.label.replace(/:$/, '');
    return { kind: 'heading', text, level: CALLOUT_HEADINGS.test(text) ? 5 : 4 };
  }

  if (lead && lead.rest && /:$/.test(lead.label) && isPseudoHeading(lead.label)) {
    return { kind: 'paragraph', heading: lead.label, text: lead.rest };
  }

  const text = textOf(el);
  if (!text || isChrome(text)) return null;
  return { kind: 'paragraph', text };
}

interface WalkContext {
  baseUrl?: string;
}

function walk(el: Element, blocks: Block[], ctx: WalkContext): void {
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

    if (name === 'figure') {
      const images: Block[] = [];
      pushImages(child, images, ctx.baseUrl);
      if (images.length > 0) {
        const caption = textOf(child.querySelector('figcaption'));
        for (const image of images) {
          if (caption && !isChrome(caption)) (image as ImageBlock).caption = caption;
          blocks.push(image);
        }
        continue;
      }
      // A figure holding a table or a snippet rather than a picture.
      walk(child, blocks, ctx);
      continue;
    }

    if (name === 'img') {
      const image = imageBlock(child, ctx.baseUrl);
      if (image) blocks.push(image);
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
      walk(child, blocks, ctx);
      continue;
    }

    // A language tab strip: one program, published several times over. The
    // page's own first tab is kept — that is the version the surrounding prose
    // was written about — and the rest are recorded by name only.
    const panels = languageTabPanels(child);
    if (panels) {
      const [shown, ...alternates] = panels;
      const text = codeText(shown.pre);
      if (text.length >= MIN_BLOCK_CHARS) {
        blocks.push({
          kind: 'code',
          language: shown.language,
          text: truncateCode(text),
          alsoIn: alternates.map((p) => p.language),
        });
      }
      continue;
    }

    if (name === 'p' || name === 'figcaption' || name === 'blockquote' || isTextContainer(child)) {
      // A blockquote of several paragraphs still descends; a one-line one does
      // not need to.
      if (name === 'blockquote' && !isTextContainer(child)) {
        walk(child, blocks, ctx);
        continue;
      }
      if (isLinkRow(child)) continue;
      const block = paragraphBlock(child);
      if (block) blocks.push(block);
      // A picture wrapped in a paragraph would otherwise be read as empty text.
      pushImages(child, blocks, ctx.baseUrl);
      continue;
    }

    // A wrapper can carry a sentence of its own before its block children.
    const loose = looseText(child);
    if (loose.length >= 40 && !isChrome(loose)) blocks.push({ kind: 'paragraph', text: loose });
    walk(child, blocks, ctx);
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

/** The label a site puts between a program and what it prints. */
const OUTPUT_LABEL = /^output\s*:?$/i;

/** How far back the program may sit from its own output label. */
const OUTPUT_LOOKBACK = 3;

/**
 * Folds an "Output" block into the snippet it belongs to.
 *
 * A tutorial publishes a program, the word "Output", and the text it prints as
 * three separate blocks. Kept apart they make three poor cards: the label is
 * noise, and the printed text on its own answers no question anyone would ask.
 * Folded together they make one good card — here is the program, what does it
 * print?
 */
function attachOutputs(blocks: Block[]): Block[] {
  const dropped = new Set<number>();

  for (let i = 1; i < blocks.length; i++) {
    const output = blocks[i];
    const label = blocks[i - 1];
    if (output.kind !== 'code') continue;
    const labelText = label.kind === 'paragraph' || label.kind === 'heading' ? label.text : '';
    if (!OUTPUT_LABEL.test(labelText)) continue;

    // The program is usually the block before the label, but an explanation can
    // sit between the two.
    let program: CodeBlock | null = null;
    for (let j = i - 2; j >= 0 && j >= i - 1 - OUTPUT_LOOKBACK; j--) {
      const candidate = blocks[j];
      if (dropped.has(j)) continue;
      if (candidate.kind === 'code') {
        if (!candidate.output) program = candidate;
        break;
      }
      if (candidate.kind !== 'paragraph' && candidate.kind !== 'heading') break;
    }
    if (!program) continue;

    program.output = output.text;
    dropped.add(i - 1);
    dropped.add(i);
  }

  return blocks.filter((_, i) => !dropped.has(i));
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
  /**
   * The address the page was read from, used to make image addresses absolute.
   * Without it an image referenced by a relative path is dropped, rather than
   * stored as a link that would never resolve again.
   */
  baseUrl?: string;
}

/** The document's own `<base href>`, which overrides the address it was read from. */
function documentBase(doc: Document, fallback?: string): string | undefined {
  const declared = doc.querySelector('base')?.getAttribute('href')?.trim();
  if (!declared) return fallback;
  try {
    return new URL(declared, fallback).toString();
  } catch {
    return fallback;
  }
}

/** Reads an already-parsed document. Kept separate so it can be tested in Node. */
export function sectionsFromDocument(
  doc: Document,
  options: HtmlParseOptions = {}
): DocumentSection[] {
  const baseUrl = documentBase(doc, options.baseUrl);
  const body = contentBody(doc);
  if (body) stripNoise(body);

  const root = findContentRoot(doc);
  if (!root) return [];

  const blocks: Block[] = [];
  walk(root, blocks, { baseUrl });

  const title = cleanPageTitle(options.pageTitle ?? doc.title);
  return sectionsFromBlocks(dropAppendices(dropLeadingCrumbs(attachOutputs(blocks))), {
    fallbackTitle: title || undefined,
  });
}

/**
 * Reads a saved page from disk.
 *
 * The document's own `<title>` wins over the file name: a page saved from a
 * browser is often called "Untitled document.html" or worse, while the title
 * inside it is the real topic label.
 */
export async function extractHtmlSections(file: File): Promise<DocumentSection[]> {
  const doc = new DOMParser().parseFromString(await file.text(), 'text/html');
  const title = cleanPageTitle(doc.title) || file.name.replace(/\.(html?|xhtml)$/i, '');
  return sectionsFromDocument(doc, { pageTitle: title });
}
