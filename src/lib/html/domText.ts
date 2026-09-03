/**
 * Reading text out of a DOM.
 *
 * The lowest layer of the HTML parser: turning elements into strings, and
 * recognising the two shapes that carry meaning without markup to say so - a
 * row that is nothing but links, and a bolded lead-in standing in for a
 * heading a visual editor could not produce.
 *
 * Everything here is pure with respect to the document: it reads, never writes.
 */

/** A container of these only is a paragraph, not a wrapper to descend into. */
export const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn',
  'em', 'i', 'img', 'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span',
  'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
]);

/** Page controls that survive the structural filters because they read as prose. */
const CHROME_TEXT =
  /^(is this page useful\??|was this (page )?helpful\??|edit (this )?page|previous|next|on this page|table of contents|in this article|share (this)?|copy( link| code)?|skip to (main )?content|back to top|menu|search|subscribe|sign (in|up)|log in|accept( all)?( cookies)?|cookie (policy|settings)|advertisement|loading…?|show more|read more)$/i;

export const MIN_BLOCK_CHARS = 3;

export function tag(el: Element): string {
  return el.tagName.toLowerCase();
}

/** Node types worth reading: elements and text. Comments are not text. */
const ELEMENT_NODE = 1;

export const TEXT_NODE = 3;

/** Collapses the whitespace a page's markup leaves between inline elements. */
export function tidyInline(text: string): string {
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
export function joinNodes(nodes: ChildNode[], skip?: (child: Element) => boolean): string {
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
export function textOf(el: Element | null): string {
  if (!el) return '';
  return tidyInline(joinNodes(Array.from(el.childNodes))).replace(/\s*[#¶]\s*$/, '');
}

/**
 * True when a block is nothing but links — a pager, a breadcrumb trail, or a
 * "see also" row. One link inside a sentence is ordinary prose, so the test is
 * about how much of the text is link text, not whether links are present.
 */
export function isLinkRow(el: Element): boolean {
  const links = Array.from(el.querySelectorAll('a'));
  if (links.length < 2) return false;
  const linkChars = links.reduce((n, a) => n + textOf(a).length, 0);
  const total = textOf(el).length;
  return total > 0 && linkChars >= total * 0.9;
}

export function isChrome(text: string): boolean {
  return text.length < MIN_BLOCK_CHARS || CHROME_TEXT.test(text);
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
export function boldLead(el: Element): { label: string; rest: string } | null {
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
export function isPseudoHeading(label: string): boolean {
  if (label.length < 3 || label.length > 80) return false;
  if (label.split(/\s+/).length > 12) return false;
  return !/[.!?]$/.test(label);
}
