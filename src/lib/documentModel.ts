/**
 * A layout-aware document model: the shared vocabulary every parser emits.
 *
 * Each source format — PDF, pptx, Markdown, HTML — produces typed Blocks rather
 * than a string of page text, and the card generator reads only these. Keeping
 * column boundaries and table structure in the model is what makes correct cards
 * from a table or a two-column slide possible at all.
 */

export interface TableBlock {
  kind: 'table';
  headers: string[];
  rows: string[][];
  /** Nearest preceding heading/title, if any. */
  context?: string;
}

export interface ListBlock {
  kind: 'list';
  heading?: string;
  items: string[];
  context?: string;
}

export interface ParagraphBlock {
  kind: 'paragraph';
  text: string;
  /** An inline label that introduced this text, e.g. "Substance use
   *  vulnerability:". Kept separate so it can become a card front. */
  heading?: string;
  context?: string;
}

export interface HeadingBlock {
  kind: 'heading';
  text: string;
  /** 1 = page/slide title, 2 = section heading within the page. */
  level: number;
}

export interface CodeBlock {
  kind: 'code';
  /** Fence info string, e.g. "ts" or "jsx". */
  language?: string;
  text: string;
  /**
   * What the snippet prints when run.
   *
   * Tutorial sites publish a program and its output as two separate blocks with
   * an "Output" label between them. They are kept together here because the
   * pair is what makes the card: "what does this print?" needs both halves, and
   * an output block on its own says nothing at all.
   */
  output?: string;
  /**
   * Other languages the same program was published in, when the snippet was
   * taken from a language tab strip. Recorded so a card can name the language
   * it is showing without implying the idea is specific to it.
   */
  alsoIn?: string[];
  /** The line that introduced the snippet, e.g. "Always create a new Map
   *  instance:". Kept separate so it can become a card front. */
  heading?: string;
  context?: string;
}

/**
 * A diagram worth keeping.
 *
 * Most images on a page are furniture — logos, avatars, share icons, tracking
 * pixels — so an image reaches this model only after surviving the content
 * tests in the HTML reader. `src` is absolute by the time it lands here: a card
 * outlives the page it was drafted from, and a relative path would break as
 * soon as it was stored.
 */
export interface ImageBlock {
  kind: 'image';
  src: string;
  /** The image's own alt text, when the page bothered to write one. */
  alt?: string;
  /** The figcaption, when the image sat inside a figure. */
  caption?: string;
  /** The line that introduced the image, so it can become a card front. */
  heading?: string;
  context?: string;
}

export type Block =
  | TableBlock
  | ListBlock
  | ParagraphBlock
  | HeadingBlock
  | CodeBlock
  | ImageBlock;

export interface DocumentSection {
  /** "Page 3", "Slide 3" or "Section 3" — shown on the card as its source. */
  label: string;
  /** The page/slide title, if one was detected. */
  title?: string;
  /**
   * Which document this section came from, when a deck is built from several
   * at once. Drafting batches never mix groups, so every card in a batch can be
   * attributed to the right source.
   */
  group?: string;
  blocks: Block[];
}

/** Raw positioned text as handed over by pdf.js (or synthesized from pptx). */
export interface PositionedItem {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

/**
 * Files in each block the section title it belongs to, where it has none.
 *
 * Every format needs this and each one wrote it out: the three copies were
 * identical down to the variable name. Headings are skipped because a heading
 * is context rather than something that needs it.
 */
export function applyContext(blocks: Block[], title: string | undefined): void {
  for (const block of blocks) {
    if (block.kind !== 'heading' && !block.context) block.context = title;
  }
}
