import type { Block, CodeBlock, DocumentSection, ListBlock, TableBlock } from './documentModel';
import { stripRepeatedFurniture } from './layoutAnalysis';

/**
 * Reads a Markdown file into structured sections.
 *
 * Markdown is the easiest of the three formats: the structure is written down
 * rather than inferred, so headings, lists and tables map straight onto blocks
 * with no geometry work. The real decisions are which heading level splits the
 * file into sections, and how much inline syntax to strip — a card front
 * reading "**What is _mitosis_?**" would be worse than the plain sentence.
 *
 * Deliberately hand-rolled rather than pulling in a CommonMark parser: we need
 * block structure only, and every extra dependency ships to the browser.
 */

/**
 * A section longer than this is split again at its next heading level.
 *
 * Section size is the biggest lever on how many cards a document yields: the
 * model is asked for the facts worth learning in a section, and it answers at
 * roughly the same length whether that section is three paragraphs or a whole
 * chapter. A reference document with 3000-word top-level headings was being
 * summarised into a handful of cards. Splitting down to a few paragraphs per
 * section is what makes the yield track the document's actual content.
 */
const SECTION_CHAR_BUDGET = 1200;

/** Longer snippets are truncated; the opening lines carry the idea. */
const MAX_CODE_CHARS = 1200;

// ---------------------------------------------------------------------------
// Inline syntax
// ---------------------------------------------------------------------------

/** Strips inline markup so card text reads as plain prose. */
export function stripInline(text: string): string {
  return (
    text
      // Images carry no studiable text; their alt text is usually a file name.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
      // Links keep their label and drop the target.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // A footnote marker must go before reference links, or "[^1]" survives.
      .replace(/\[\^[^\]]+\]/g, '')
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      // Autolinks: <https://…> keeps the URL, other tags are dropped.
      .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
      .replace(/<\/?[A-Za-z][^>]*>/g, '')
      // Code spans, longest fence first.
      .replace(/``([^`]+)``/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*\n]+)\*/g, '$1')
      // Underscore emphasis only at word boundaries, so snake_case survives.
      .replace(/(^|[^A-Za-z0-9_])___([^_]+)___(?![A-Za-z0-9_])/g, '$1$2')
      .replace(/(^|[^A-Za-z0-9_])__([^_]+)__(?![A-Za-z0-9_])/g, '$1$2')
      .replace(/(^|[^A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, '$1$2')
      .replace(/~~([^~]+)~~/g, '$1')
      // Backslash escapes are the last step: unescaping earlier would let a
      // literal "\*" be read as emphasis.
      .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// ---------------------------------------------------------------------------
// Line-level patterns
// ---------------------------------------------------------------------------

const ATX_HEADING_RE = /^ {0,3}(#{1,6})\s+(.*)$/;
const LIST_ITEM_RE = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+(.*)$/;
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])\s*(?:\1\s*){2,}$/;
const SETEXT_UNDERLINE_RE = /^ {0,3}(=+|-+)\s*$/;
const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*(\S*)/;
/** "Common features:" — a label that introduces the block below it. */
const INLINE_LABEL_RE = /^[^.!?]{3,70}:$/;
/** An emphasised term followed by a dash or colon, e.g. "**Secure** — ...". */
const TERM_PAIR_RE = /^(\*\*|__|\*|_)(.{2,60}?)\1\s*[—–:-]\s+(.+)$/;
/** A paragraph that is nothing but a bold or italic run acts as a heading. */
const EMPHASIS_ONLY_RE = /^(\*\*|__|\*|_)([^*_]{2,80})\1:?$/;

function headingLevel(line: string): number | null {
  const m = line.match(ATX_HEADING_RE);
  return m ? m[1].length : null;
}

function headingText(line: string): string {
  return stripInline(line.match(ATX_HEADING_RE)![2].replace(/\s+#+\s*$/, ''));
}

/** True when `line` closes a fence opened with `open`. */
function closesFence(line: string, open: string): boolean {
  const m = line.match(FENCE_RE);
  return !!m && m[1][0] === open[0] && m[1].length >= open.length;
}

function isBlockStart(line: string): boolean {
  return (
    !line.trim() ||
    ATX_HEADING_RE.test(line) ||
    LIST_ITEM_RE.test(line) ||
    THEMATIC_BREAK_RE.test(line) ||
    FENCE_RE.test(line)
  );
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Flattens the source into content lines: front matter, comments and quote
 * markers are removed, and setext headings are rewritten as their ATX
 * equivalents so only one heading form has to be handled later.
 *
 * Fenced code passes through untouched — a `>` or `---` inside a snippet is
 * code, not Markdown — and becomes a block of its own further down.
 */
function normalize(markdown: string): string[] {
  let text = markdown.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  const lines = text.split('\n');

  // YAML front matter, only when it opens the file.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && /^(-{3,}|\.{3,})\s*$/.test(l.trim()));
    if (end > 0) lines.splice(0, end + 1);
  }

  const out: string[] = [];
  let fence: string | null = null;

  for (const raw of lines) {
    if (fence) {
      out.push(raw);
      if (closesFence(raw, fence)) fence = null;
      continue;
    }

    // Blockquote markers are dropped so quoted content parses as normal blocks.
    const line = raw.replace(/^\s{0,3}(?:>\s?)+/, '');

    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      fence = fenceMatch[1];
      out.push(line);
      continue;
    }

    // Setext heading: the previous line was the text, this one underlines it.
    const prev = out[out.length - 1];
    if (
      SETEXT_UNDERLINE_RE.test(line) &&
      prev &&
      prev.trim() &&
      !ATX_HEADING_RE.test(prev) &&
      !LIST_ITEM_RE.test(prev) &&
      !prev.includes('|')
    ) {
      const level = line.trim().startsWith('=') ? '#' : '##';
      out[out.length - 1] = `${level} ${prev.trim()}`;
      continue;
    }

    out.push(line);
  }

  return out;
}

/**
 * Heading level per line, or null where there is none.
 *
 * Lines inside a fence never count: `# Update single entry` is a comment in a
 * snippet, and treating it as a heading would cut that snippet in half.
 */
function headingLevels(lines: string[]): (number | null)[] {
  const levels: (number | null)[] = [];
  let fence: string | null = null;

  for (const line of lines) {
    if (fence) {
      levels.push(null);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const m = line.match(FENCE_RE);
    if (m) {
      fence = m[1];
      levels.push(null);
      continue;
    }
    levels.push(headingLevel(line));
  }

  return levels;
}

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

/** Removes the indentation shared by every line of a snippet. */
function dedent(body: string[]): string[] {
  const indents = body.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length);
  const shared = indents.length > 0 ? Math.min(...indents) : 0;
  return body.map((l) => l.slice(shared));
}

function truncateCode(text: string): string {
  if (text.length <= MAX_CODE_CHARS) return text;
  const cut = text.slice(0, MAX_CODE_CHARS);
  const lastBreak = cut.lastIndexOf('\n');
  return `${lastBreak > 0 ? cut.slice(0, lastBreak) : cut}\n…`;
}

/**
 * Reads a fenced code block starting at `i`; returns it and the next index.
 *
 * Code used to be discarded, on the theory that syntax makes poor flashcard
 * text. In a technical document that threw away most of the content: whole
 * sections were left as a heading with nothing under it, and the model had
 * nothing to write a card from. The snippet is the answer to "how do I do
 * this?", so it is kept and handed to the drafter like any other block.
 */
function readCode(lines: string[], i: number): { block: CodeBlock | null; next: number } {
  const m = lines[i].match(FENCE_RE)!;
  const open = m[1];
  const language = m[2] ? m[2].slice(0, 20) : undefined;

  const body: string[] = [];
  let j = i + 1;
  while (j < lines.length && !closesFence(lines[j], open)) {
    body.push(lines[j]);
    j++;
  }
  if (j < lines.length) j++; // consume the closing fence

  const text = dedent(body).join('\n').trim();
  if (!text) return { block: null, next: j };
  return { block: { kind: 'code', language, text: truncateCode(text) }, next: j };
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => stripInline(cell.replace(/\\\|/g, '|')));
}

function isTableStart(lines: string[], i: number): boolean {
  const header = lines[i];
  const delimiter = lines[i + 1];
  if (!header || !delimiter) return false;
  if (!header.includes('|')) return false;
  if (!TABLE_DELIMITER_RE.test(delimiter)) return false;
  return splitTableRow(header).length >= 2;
}

/** Reads a pipe table at `i`; returns the block, its raw rows and the next index. */
function readTable(
  lines: string[],
  i: number
): { block: TableBlock | null; rows: string[][]; next: number } {
  const headers = splitTableRow(lines[i]);
  let j = i + 2;
  const rows: string[][] = [];

  while (j < lines.length && lines[j].trim() && lines[j].includes('|')) {
    const cells = splitTableRow(lines[j]);
    // Ragged rows are squared off against the header so cell/column pairing
    // stays correct even when a row omits its trailing separators.
    while (cells.length < headers.length) cells.push('');
    rows.push(cells.slice(0, headers.length));
    j++;
  }

  if (headers.some((h) => !h) || rows.length === 0) {
    return { block: null, rows: [headers, ...rows], next: j };
  }
  return { block: { kind: 'table', headers, rows }, rows, next: j };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/**
 * Rewrites the Markdown idiom for a definition — "**Secure** — explores
 * freely" — into the "Term: definition" form the card generator already
 * recognises. The emphasis is what makes this safe: a dash inside ordinary
 * prose is not preceded by a bolded run.
 */
function normalizeTermPair(raw: string): string {
  const m = raw.trim().match(TERM_PAIR_RE);
  if (!m) return raw;
  const term = m[2].trim().replace(/[:—–-]+$/, '').trim();
  const definition = m[3].trim();
  if (!term || !definition) return raw;
  return `${term}: ${definition}`;
}

function cleanItem(text: string): string {
  // Task-list checkboxes are UI, not content.
  return stripInline(normalizeTermPair(text.replace(/^\[[ xX]\]\s*/, '')));
}

/** Reads a run of list items starting at `i`; returns the items and next index. */
function readList(lines: string[], i: number): { items: string[]; next: number } {
  const items: string[] = [];
  let j = i;

  while (j < lines.length) {
    const m = lines[j].match(LIST_ITEM_RE);
    if (m) {
      // Nested items become items of their own. Their wording usually stands
      // alone, and flattening keeps one list per run rather than one per depth.
      items.push(cleanItem(m[2]));
      j++;
      // Indented continuation lines belong to the item above them.
      while (
        j < lines.length &&
        lines[j].trim() &&
        /^\s+/.test(lines[j]) &&
        !LIST_ITEM_RE.test(lines[j]) &&
        !ATX_HEADING_RE.test(lines[j]) &&
        !FENCE_RE.test(lines[j])
      ) {
        items[items.length - 1] = `${items[items.length - 1]} ${cleanItem(lines[j].trim())}`.trim();
        j++;
      }
      continue;
    }

    // A loose list separates its items with blank lines.
    if (!lines[j].trim()) {
      let k = j;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k < lines.length && LIST_ITEM_RE.test(lines[k])) {
        j = k;
        continue;
      }
    }
    break;
  }

  return { items: items.filter(Boolean), next: j };
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  /** Nearest preceding heading: the scope of a table, and the question a
   *  list below it answers. */
  let nearestHeading: string | undefined;
  /** An inline label ("Common features:") introducing the next block. Kept
   *  apart from real headings because it reads as a different question. */
  let pendingLabel: string | undefined;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim() || THEMATIC_BREAK_RE.test(line)) {
      i++;
      continue;
    }

    if (FENCE_RE.test(line)) {
      const { block, next } = readCode(lines, i);
      if (block) {
        // "Always create a new Map instance:" is the question this snippet
        // answers, so it travels with the code instead of being dropped.
        block.heading = pendingLabel;
        blocks.push(block);
      }
      pendingLabel = undefined;
      i = next;
      continue;
    }

    const level = headingLevel(line);
    if (level !== null) {
      const text = headingText(line);
      if (text) {
        blocks.push({ kind: 'heading', text, level: 2 });
        nearestHeading = text;
        pendingLabel = undefined;
      }
      i++;
      continue;
    }

    if (isTableStart(lines, i)) {
      const { block, rows, next } = readTable(lines, i);
      if (block) {
        block.context = nearestHeading;
        blocks.push(block);
      } else {
        // Pipes without a usable header row: keep the text as prose rather than
        // dropping it, joining each row's cells back together.
        for (const row of rows) {
          const text = row.filter(Boolean).join(' — ');
          if (text) blocks.push({ kind: 'paragraph', text, heading: pendingLabel });
        }
      }
      pendingLabel = undefined;
      i = next;
      continue;
    }

    if (LIST_ITEM_RE.test(line)) {
      const { items, next } = readList(lines, i);
      if (items.length > 0) {
        const list: ListBlock = {
          kind: 'list',
          heading: pendingLabel ?? nearestHeading,
          items,
        };
        blocks.push(list);
        pendingLabel = undefined;
      }
      i = next;
      continue;
    }

    // Paragraph: consecutive lines up to the next block boundary.
    const paragraphLines: string[] = [];
    while (i < lines.length && !isBlockStart(lines[i]) && !isTableStart(lines, i)) {
      paragraphLines.push(lines[i].trim());
      i++;
    }
    const raw = paragraphLines.join(' ').trim();
    if (!raw) continue;

    const emphasised = paragraphLines.length === 1 ? raw.match(EMPHASIS_ONLY_RE) : null;
    const text = stripInline(paragraphLines.length === 1 ? normalizeTermPair(raw) : raw);
    if (!text) continue;

    if (emphasised) {
      // A standalone bold line ("**Key risks**") is a heading in disguise.
      const label = stripInline(emphasised[2]).replace(/:$/, '');
      if (label) {
        blocks.push({ kind: 'heading', text: label, level: 2 });
        nearestHeading = label;
        pendingLabel = undefined;
      }
      continue;
    }

    if (INLINE_LABEL_RE.test(text)) {
      pendingLabel = text.replace(/:$/, '');
      continue;
    }

    blocks.push({ kind: 'paragraph', text, heading: pendingLabel });
    pendingLabel = undefined;
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Sectioning
// ---------------------------------------------------------------------------

/** One future section: the heading path leading to it, and its own lines. */
interface Run {
  /** Ancestor headings, outermost first, ending with this run's own heading. */
  titles: string[];
  lines: string[];
}

function charCount(lines: string[]): number {
  return lines.reduce((n, l) => n + l.trim().length + 1, 0);
}

/**
 * Splits lines into runs at the shallowest heading level present, descending a
 * level at a time while a run is still larger than the section budget.
 *
 * Two things make this adaptive rather than a fixed "split at H2": a document
 * whose only H1 is its own title would otherwise be one enormous section, and
 * a reference document mixes short H2s with H2s holding a dozen subsections.
 */
function buildRuns(lines: string[], titles: string[], minLevel: number): Run[] {
  const levels = headingLevels(lines);

  let level: number | null = null;
  for (const l of levels) {
    if (l !== null && l >= minLevel && (level === null || l < level)) level = l;
  }
  if (level === null) return [{ titles, lines }];

  const groups: { title?: string; lines: string[] }[] = [{ lines: [] }];
  lines.forEach((line, i) => {
    if (levels[i] === level) groups.push({ title: headingText(line) || undefined, lines: [] });
    else groups[groups.length - 1].lines.push(line);
  });

  const filled = groups.filter((g) => g.title || g.lines.some((l) => l.trim()));
  // A single group means this level spans the whole file — the document title,
  // typically — so the divider has to come from the level below it.
  const lone = filled.length === 1;

  const runs: Run[] = [];
  for (const group of filled) {
    const chain = group.title ? [...titles, group.title] : titles;
    const oversized = charCount(group.lines) > SECTION_CHAR_BUDGET;
    if (oversized || (lone && group.title)) {
      runs.push(...buildRuns(group.lines, chain, level + 1));
    } else {
      runs.push({ titles: chain, lines: group.lines });
    }
  }

  return runs;
}

/** "week-3_notes.md" -> "week 3 notes", used when a file has no headings. */
function titleFromFileName(fileName: string): string {
  return fileName
    .replace(/\.(md|markdown|mdown|mkd)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseMarkdownSections(markdown: string, fileName = ''): DocumentSection[] {
  const runs = buildRuns(normalize(markdown), [], 1);

  const sections: DocumentSection[] = [];
  const chains: string[][] = [];

  for (const run of runs) {
    const blocks = parseBlocks(run.lines);
    if (blocks.length === 0) continue;

    const title = run.titles[run.titles.length - 1];
    // A list sitting directly under the section heading has no nearer label,
    // and the heading is exactly the question it answers.
    if (title) {
      for (const b of blocks) {
        if (b.kind === 'list' && !b.heading) b.heading = title;
      }
    }

    sections.push({ label: `Section ${sections.length + 1}`, title, blocks });
    chains.push(run.titles);
  }

  // A file with no headings has no title for the card generator to work from,
  // which would leave a page of prose yielding nothing. The file name is the
  // one topic label such a document does carry.
  if (sections.length === 1 && !sections[0].title) {
    const fallback = titleFromFileName(fileName);
    if (fallback) sections[0].title = fallback;
  }

  // Furniture is detected on body blocks only, before the heading path is added
  // below: an ancestor heading repeated across sibling sections is context, not
  // the running footer that rule is meant to catch.
  return stripRepeatedFurniture(sections).map((section, i) => {
    for (const b of section.blocks) {
      if (b.kind !== 'heading' && !b.context) b.context = section.title;
    }
    // The heading path leads the section, so a card drafted from a subsection
    // still knows which document and topic it belongs to.
    const path: Block[] = chains[i].map((text) => ({ kind: 'heading', text, level: 1 }));
    return { ...section, blocks: [...path, ...section.blocks] };
  });
}

export async function extractMarkdownSections(file: File): Promise<DocumentSection[]> {
  return parseMarkdownSections(await file.text(), file.name);
}
