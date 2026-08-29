import type { Block, DocumentSection } from './documentModel';
import { stripRepeatedFurniture } from './layoutAnalysis';

/**
 * Turns a flat block stream into sections.
 *
 * Markdown and HTML both arrive as one long run of blocks whose headings carry
 * their own level, so the question "where does a section end?" has the same
 * answer for both. PDF and PPTX do not need this — a page or a slide is already
 * a section.
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
export const SECTION_CHAR_BUDGET = 1200;

/** Longer snippets are truncated; the opening lines carry the idea. */
export const MAX_CODE_CHARS = 1200;

export function truncateCode(text: string): string {
  if (text.length <= MAX_CODE_CHARS) return text;
  const cut = text.slice(0, MAX_CODE_CHARS);
  const lastBreak = cut.lastIndexOf('\n');
  return `${lastBreak > 0 ? cut.slice(0, lastBreak) : cut}\n…`;
}

/** Roughly how much text a block carries, for the size budget. */
function blockLength(block: Block): number {
  switch (block.kind) {
    case 'heading':
      return block.text.length;
    case 'paragraph':
      return block.text.length;
    case 'code':
      return block.text.length;
    case 'list':
      return block.items.join(' ').length;
    case 'table':
      return block.headers.join(' ').length + block.rows.flat().join(' ').length;
  }
}

/** One future section: the heading path leading to it, and its own blocks. */
interface Run {
  /** Ancestor headings, outermost first, ending with this run's own heading. */
  titles: string[];
  blocks: Block[];
}

/**
 * Deepest heading level that may start a section.
 *
 * H5/H6 — and the bold-line pseudo-headings Markdown authors write — label a
 * paragraph rather than open a topic. Letting them divide the document would
 * strand a single sentence in a section of its own.
 */
const MAX_SPLIT_LEVEL = 4;

/**
 * Splits blocks into runs, one per heading, descending a level at a time.
 *
 * Two rules decide how deep to go. A level that yields a single group is the
 * document's own title, so the divider has to come from the level below it;
 * and any run larger than the section budget is divided again. Descending on
 * size rather than at a fixed depth is what makes this work on both a page of
 * notes and a reference manual: a short document keeps its topic headings,
 * while an H2 holding a dozen subsections is divided at its H3s.
 */
function buildRuns(blocks: Block[], titles: string[], minLevel: number): Run[] {
  let level: number | null = null;
  for (const b of blocks) {
    if (b.kind !== 'heading') continue;
    if (b.level < minLevel || b.level > MAX_SPLIT_LEVEL) continue;
    if (level === null || b.level < level) level = b.level;
  }
  if (level === null) return [{ titles, blocks }];

  const groups: { title?: string; blocks: Block[] }[] = [{ blocks: [] }];
  for (const b of blocks) {
    if (b.kind === 'heading' && b.level === level) groups.push({ title: b.text, blocks: [] });
    else groups[groups.length - 1].blocks.push(b);
  }

  const filled = groups.filter((g) => g.title || g.blocks.length > 0);
  // One group means this level is the document title, not a divider.
  const lone = filled.length === 1;

  const runs: Run[] = [];
  for (const group of filled) {
    const chain = group.title ? [...titles, group.title] : titles;
    const size = group.blocks.reduce((n, b) => n + blockLength(b) + 1, 0);
    if (size > SECTION_CHAR_BUDGET || (lone && group.title)) {
      runs.push(...buildRuns(group.blocks, chain, level + 1));
    } else {
      runs.push({ titles: chain, blocks: group.blocks });
    }
  }

  return runs;
}

export interface SectionOptions {
  /**
   * Title for a document that has no headings at all — the file name, or the
   * page title. Without it such a document has no topic label for the card
   * generator to work from, and yields nothing.
   */
  fallbackTitle?: string;
}

export function sectionsFromBlocks(blocks: Block[], options: SectionOptions = {}): DocumentSection[] {
  const runs = buildRuns(blocks, [], 1);

  const sections: DocumentSection[] = [];
  const chains: string[][] = [];

  for (const run of runs) {
    if (run.blocks.length === 0) continue;

    const title = run.titles[run.titles.length - 1];
    const body = run.blocks.map((b) =>
      // Headings that survive inside a section are subheadings, whatever their
      // original depth: level 1 means "page title" to the card generator.
      b.kind === 'heading' ? { ...b, level: 2 } : b
    );

    // A list sitting directly under the section heading has no nearer label,
    // and the heading is exactly the question it answers.
    if (title) {
      for (const b of body) {
        if (b.kind === 'list' && !b.heading) b.heading = title;
      }
    }

    sections.push({ label: `Section ${sections.length + 1}`, title, blocks: body });
    chains.push(run.titles);
  }

  // A document that opens with prose before its first heading — an
  // encyclopedia lead, a blog intro — leaves that section untitled. The file
  // name or page title is the topic label it should carry.
  if (options.fallbackTitle) {
    for (const section of sections) {
      if (!section.title) section.title = options.fallbackTitle;
    }
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
