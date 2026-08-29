/**
 * A layout-aware document model.
 *
 * The old pipeline flattened every page into a single string, which destroyed
 * column boundaries and table structure. Parsers now emit typed Blocks instead,
 * and the card generator reads those blocks. This is what lets us generate
 * correct cards from tables and multi-column slides.
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

export type Block = TableBlock | ListBlock | ParagraphBlock | HeadingBlock;

export interface DocumentSection {
  /** "Page 3" or "Slide 3" — shown on the card as its source. */
  label: string;
  /** The page/slide title, if one was detected. */
  title?: string;
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
