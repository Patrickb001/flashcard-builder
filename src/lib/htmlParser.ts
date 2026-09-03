import {
  INLINE_TAGS,
  MIN_BLOCK_CHARS,
  TEXT_NODE,
  boldLead,
  isChrome,
  isLinkRow,
  isPseudoHeading,
  tag,
  textOf,
} from './html/domText';
import { contentBody, findContentRoot, stripNoise } from './html/contentRoot';
import { codeLanguage, codeText, languageTabPanels } from './html/code';
import { listItems, parseTable } from './html/tables';
import { imageBlock, pushImages } from './html/images';

import type {
  Block,
  CodeBlock,
  DocumentSection,
  ImageBlock,
  ListBlock,
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

/**
 * Callout labels that documentation sites mark up as headings.
 *
 * "Note" and "Pitfall" title a box inside a section, not a topic of their own.
 * Left at their markup level they would name a section — and the card's topic
 * chip would read "Note" — so they are demoted below the split level.
 */
const CALLOUT_HEADINGS =
  /^(note|notes|pitfall|caution|warning|tip|hint|deep dive|illustrated by|under the hood|remember|example|examples|try it out)$/i;

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

/**
 * What to do with one element, chosen by its tag name.
 *
 * A handler is responsible for the whole element: it pushes what it wants and
 * descends itself if it needs to. Returning without descending is how a tag
 * says "this subtree is mine and I have read all of it".
 *
 * Written as a table rather than the chain of tag comparisons this was, because
 * the chain hid the shape of the thing: which tags are handled, and which fall
 * through to the structural rules below, is now a list you can read.
 */
const TAG_HANDLERS: Record<string, (el: Element, blocks: Block[], ctx: WalkContext) => void> = {
  pre(el, blocks) {
    const text = codeText(el);
    if (text.length >= MIN_BLOCK_CHARS) {
      blocks.push({ kind: 'code', language: codeLanguage(el), text: truncateCode(text) });
    }
  },

  figure(el, blocks, ctx) {
    const images: Block[] = [];
    pushImages(el, images, ctx.baseUrl);
    if (images.length === 0) {
      // A figure holding a table or a snippet rather than a picture.
      walk(el, blocks, ctx);
      return;
    }
    const caption = textOf(el.querySelector('figcaption'));
    for (const image of images) {
      if (caption && !isChrome(caption)) (image as ImageBlock).caption = caption;
      blocks.push(image);
    }
  },

  img(el, blocks, ctx) {
    const image = imageBlock(el, ctx.baseUrl);
    if (image) blocks.push(image);
  },

  ul: pushListItems,
  ol: pushListItems,

  dl(el, blocks) {
    const items: string[] = [];
    let term = '';
    for (const node of Array.from(el.children)) {
      if (tag(node) === 'dt') term = textOf(node);
      else if (tag(node) === 'dd') {
        const definition = textOf(node);
        if (definition) items.push(term ? `${term}: ${definition}` : definition);
      }
    }
    if (items.length > 0) blocks.push({ kind: 'list', items } as ListBlock);
  },

  table(el, blocks) {
    blocks.push(...parseTable(el));
  },

  details(el, blocks, ctx) {
    // A collapsed "deep dive" is content; its summary is the label for it.
    const summary = el.querySelector('summary');
    const label = textOf(summary);
    if (label && !isChrome(label)) blocks.push({ kind: 'heading', text: label, level: 5 });
    summary?.remove();
    walk(el, blocks, ctx);
  },
};

function pushListItems(el: Element, blocks: Block[]): void {
  if (isLinkRow(el)) return;
  const items = listItems(el);
  if (items.length > 0) blocks.push({ kind: 'list', items } as ListBlock);
}

/**
 * Maps a subtree onto blocks.
 *
 * Three kinds of rule, in order: headings, which are keyed by tag but need the
 * level read off the name; the tag table above; and the structural rules, which
 * cannot be keyed by tag at all because what decides them is the shape of the
 * element rather than its name.
 */
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

    const handler = TAG_HANDLERS[name];
    if (handler) {
      handler(child, blocks, ctx);
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
          alsoIn: alternates.map((panel) => panel.language),
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
