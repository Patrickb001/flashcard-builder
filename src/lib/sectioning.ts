import type { Block, DocumentSection } from './documentModel';
import { applyContext } from './documentModel';
import { normalizeSlug } from './textUtils';

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
const SECTION_CHAR_BUDGET = 1200;

/** Longer snippets are truncated; the opening lines carry the idea. */
const MAX_SECTION_CODE_CHARS = 1200;

/** Shortens a snippet at a line boundary, so it never ends mid-statement. */
export function truncateCode(text: string): string {
  if (text.length <= MAX_SECTION_CODE_CHARS) return text;
  const cut = text.slice(0, MAX_SECTION_CODE_CHARS);
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
      return block.text.length + (block.output?.length ?? 0);
    case 'image':
      // A picture costs the drafter almost nothing to read: it arrives as an
      // id, its alt text and its caption, not as pixels.
      return (block.alt?.length ?? 0) + (block.caption?.length ?? 0);
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
  for (const block of blocks) {
    if (block.kind !== 'heading') continue;
    if (block.level < minLevel || block.level > MAX_SPLIT_LEVEL) continue;
    if (level === null || block.level < level) level = block.level;
  }
  if (level === null) return [{ titles, blocks }];

  const groups: { title?: string; blocks: Block[] }[] = [{ blocks: [] }];
  for (const block of blocks) {
    if (block.kind === 'heading' && block.level === level) {
      groups.push({ title: block.text, blocks: [] });
    } else {
      groups[groups.length - 1].blocks.push(block);
    }
  }

  const filled = groups.filter((group) => group.title || group.blocks.length > 0);
  // One group means this level is the document title, not a divider.
  const lone = filled.length === 1;

  const runs: Run[] = [];
  for (const group of filled) {
    const chain = group.title ? [...titles, group.title] : titles;
    const size = group.blocks.reduce((total, block) => total + blockLength(block) + 1, 0);
    if (size > SECTION_CHAR_BUDGET || (lone && group.title)) {
      runs.push(...buildRuns(group.blocks, chain, level + 1));
    } else {
      runs.push({ titles: chain, blocks: group.blocks });
    }
  }

  return runs;
}

/** Options for sectionsFromBlocks. */
export interface SectionOptions {
  /**
   * Title for a document that has no headings at all — the file name, or the
   * page title. Without it such a document has no topic label for the card
   * generator to work from, and yields nothing.
   */
  fallbackTitle?: string;
}

/**
 * Cuts a flat block stream into sections, the entry point Markdown and HTML
 * both use.
 *
 * Four passes over each run: split at headings (descending a level whenever a
 * run exceeds the size budget), copy the blocks so the caller's array is never
 * written into, propagate the nearest heading onto unlabelled lists, snippets
 * and images, then prefix each section's title with its heading path.
 *
 * Section size, not document size, is what sets how many cards a document
 * yields — see SECTION_CHAR_BUDGET above.
 */
export function sectionsFromBlocks(blocks: Block[], options: SectionOptions = {}): DocumentSection[] {
  const runs = buildRuns(blocks, [], 1);

  const sections: DocumentSection[] = [];
  const chains: string[][] = [];

  for (const run of runs) {
    if (run.blocks.length === 0) continue;

    // A document that opens with prose before its first heading — an
    // encyclopedia lead, a blog intro — leaves this run untitled. The file name
    // or page title is the topic label it should carry, and it is resolved here
    // rather than afterwards because the labelling below reads it.
    const title = run.titles[run.titles.length - 1] ?? options.fallbackTitle;
    // Every block is copied, not just the headings. The labelling pass below
    // writes `heading` onto lists, snippets and images, and with the originals
    // passed through by reference that wrote straight into the caller's array -
    // so calling this twice on the same blocks gave two different answers.
    const body = run.blocks.map((block) =>
      // Headings that survive inside a section are subheadings, whatever their
      // original depth: level 1 means "page title" to the card generator.
      block.kind === 'heading' ? { ...block, level: 2 } : { ...block }
    );

    // A list, a snippet and a diagram all arrive unlabelled: nothing in the
    // markup says what they are for. The nearest heading above is what names
    // them — "Flowchart of If-Else Statement" rather than the whole section —
    // and that label becomes the card front.
    //
    // A label is consumed by the first block it introduces. Without that, the
    // caption above a diagram went on to title the code sample after it, and
    // the snippet was offered to the reader as a flowchart.
    let nearest = title;
    for (let i = 0; i < body.length; i++) {
      const block = body[i];

      if (block.kind === 'heading') {
        const next = body[i + 1];
        // A bold line sitting directly above a figure is its caption, not a
        // heading over everything that follows. Read as a heading it went on to
        // title the code sample after the picture, and the snippet was offered
        // to the reader as a flowchart.
        if (next && next.kind === 'image') {
          if (!next.heading) next.heading = block.text;
          i += 1;
          continue;
        }
        nearest = block.text;
        continue;
      }

      // A labelled paragraph names its subtopic as surely as a heading does.
      if (block.kind === 'paragraph') {
        if (block.heading) nearest = block.heading;
        continue;
      }

      if (block.kind === 'list' || block.kind === 'code' || block.kind === 'image') {
        if (!block.heading) block.heading = nearest;
      }
    }

    sections.push({ label: `Section ${sections.length + 1}`, title, blocks: body });
    chains.push(run.titles);
  }

  // Furniture is detected on body blocks only, before the heading path is added
  // below: an ancestor heading repeated across sibling sections is context, not
  // the running footer that rule is meant to catch.
  return stripRepeatedFurniture(sections).map((section, i) => {
    applyContext(section.blocks, section.title);
    // The heading path leads the section, so a card drafted from a subsection
    // still knows which document and topic it belongs to.
    const path: Block[] = chains[i].map((text) => ({ kind: 'heading', text, level: 1 }));
    return { ...section, blocks: [...path, ...section.blocks] };
  });
}

/**
 * Removes running headers/footers: any line that appears on more than 30% of
 * pages is page furniture, not content. This is what drops boilerplate like the
 * repeated "Clinical relevance:" footer.
 */
export function stripRepeatedFurniture(sections: DocumentSection[]): DocumentSection[] {
  if (sections.length < 4) return sections;

  const counts = new Map<string, number>();
  for (const section of sections) {
    const seen = new Set<string>();
    for (const block of section.blocks) {
      const text = blockSignature(block);
      if (text && !seen.has(text)) {
        seen.add(text);
        counts.set(text, (counts.get(text) ?? 0) + 1);
      }
    }
  }

  const threshold = Math.max(3, Math.ceil(sections.length * 0.3));
  const furniture = new Set(
    [...counts.entries()].filter(([, count]) => count >= threshold).map(([text]) => text)
  );

  // Printed web pages repeat the document's own section list in a sidebar or
  // page footer. Those entries are titles of OTHER sections, so any short block
  // whose text matches a different section's title is navigation, not content.
  const titles = new Map<string, string>();
  for (const section of sections) {
    if (section.title) titles.set(normalizeSlug(section.title), section.label);
  }

  return sections.map((section) => ({
    ...section,
    blocks: section.blocks.filter((block) => {
      if (furniture.has(blockSignature(block))) return false;
      if (block.kind !== 'paragraph' && block.kind !== 'heading') return true;
      const text = block.text;
      if (text.length > 60) return true;
      const owner = titles.get(normalizeSlug(text));
      return !owner || owner === section.label;
    }),
  }));
}

function blockSignature(block: Block): string {
  switch (block.kind) {
    case 'paragraph':
      return block.text.slice(0, 80).toLowerCase();
    case 'heading':
      return block.text.slice(0, 80).toLowerCase();
    case 'list':
      return block.items.join('|').slice(0, 80).toLowerCase();
    default:
      return '';
  }
}
