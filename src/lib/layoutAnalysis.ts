import type { Block, DocumentSection, PositionedItem } from './documentModel';

/**
 * Turns positioned text fragments into structured blocks.
 *
 * Everything here is pure geometry + string work with no pdf.js dependency,
 * so it can be unit-tested in Node against real documents.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Two items on the same baseline join into one line only if the horizontal
 *  gap between them is under this multiple of the font size. This is the rule
 *  that keeps separate columns separate. */
const SAME_LINE_GAP_RATIO = 1.6;
/** Below this ratio the items are joined with no space (word fragments). */
const NO_SPACE_GAP_RATIO = 0.3;
/** Baselines within this multiple of font size count as the same line. */
const BASELINE_TOLERANCE_RATIO = 0.4;
/** A vertical gap larger than this multiple of line height starts a new block. */
const BLOCK_BREAK_RATIO = 1.75;
/** Column x-anchors must repeat on at least this many lines to imply a table. */
const MIN_TABLE_ROWS = 3;
/** X positions within this many points are treated as the same column anchor. */
const COLUMN_ANCHOR_TOLERANCE = 12;

/** Only true bullet glyphs. Dashes are deliberately excluded: a lone "-" is far
 *  more often a hyphen inside a broken word ("self" + "-" + "esteem") than a
 *  list marker, and it is resolved by the line-continuation path instead. */
const BULLET_RE = /^[•◦▪‣∙▶►·]\s*$/;
const LEADING_BULLET_RE = /^[\s]*[•◦▪‣∙▶►·]+\s*/;

// ---------------------------------------------------------------------------
// Step 1: normalize individual items
// ---------------------------------------------------------------------------

/**
 * PowerPoint renders letter-spaced headings as "N O R M A L". Collapsing this
 * per item (rather than per line) preserves the real word boundaries, so
 * "N O R M A L" + "G R I E F" becomes "NORMAL GRIEF" and not "NORMALGRIEF".
 */
function collapseLetterSpacing(str: string): { text: string; wasSpaced: boolean } {
  const trimmed = str.trim();
  if (trimmed.length < 3) return { text: str, wasSpaced: false };
  // Matches "A B C" / "( D S M" / "2 0 2 2 )" — single-char tokens with spaces.
  if (!/^(\S\s)+\S$/.test(trimmed)) return { text: str, wasSpaced: false };
  const collapsed = trimmed.replace(/\s+/g, '');
  const alnum = collapsed.replace(/[^A-Za-z0-9]/g, '').length;
  if (alnum < 2) return { text: str, wasSpaced: false };
  return { text: collapsed, wasSpaced: true };
}

/**
 * Decides whether two adjacent fragments should be glued together with no
 * space. PDF generators split words at hyphens and sometimes mid-word, but they
 * also place separately-styled words very close together. Gluing on distance
 * alone produces "DescribeErikson's", so the boundary characters get a vote.
 */
function shouldJoinWithoutSpace(prev: string, next: string, gap: number, fontSize: number): boolean {
  if (gap >= fontSize * NO_SPACE_GAP_RATIO) return false;

  const prevText = prev.trimEnd();
  const nextText = next.trimStart();
  const prevEnd = prevText.slice(-1);
  const nextStart = nextText.charAt(0);

  // A dash on either side means the token was split at the dash.
  if (/[-–—]/.test(prevEnd) || /[-–—]/.test(nextStart)) return true;

  // Brackets hug their contents.
  if (/[([{]/.test(prevEnd) || /[)\]}]/.test(nextStart)) return true;

  // Sentence and clause punctuation always takes a following space.
  if (/[.,:;!?]/.test(prevEnd)) return false;

  // A capital starting the next fragment signals a new word.
  if (/[A-Z]/.test(nextStart)) return false;

  // A true mid-word split ("ab" + "stractly") always leaves one very short
  // stub. Two full-length words sitting close together are still two words.
  return prevText.length <= 3 || nextText.length <= 3;
}

/**
 * Repairs spacing artifacts left by letter-spaced runs that were only partly
 * collapsed, e.g. "( 0 - 2 y r )" from a tracked-out slide heading.
 */
function normalizeSpacing(text: string): string {
  return text
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/(\d)\s*([\u2013\u2014-])\s*(\d)/g, '$1$2$3')
    .replace(/(\d)\s*y\s+r\b/gi, '$1 yr')
    .replace(/(\d)\s*m\s+o\b/gi, '$1 mo')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Step 2: assemble lines (gutter-safe)
// ---------------------------------------------------------------------------

export interface Line {
  text: string;
  x: number;
  xEnd: number;
  y: number;
  fontSize: number;
  isBullet: boolean;
  /** True when the source text was letter-spaced ("N O R M A L"), which in
   *  slide decks is a strong signal that the line is a heading even when its
   *  font size matches the body text. */
  wasSpaced: boolean;
  /** X anchors of every fragment on the line — used for table detection. */
  anchors: number[];
}

/**
 * Groups items into lines. Critically, items are consumed in the order pdf.js
 * emits them (which follows the document's own reading order, shape by shape)
 * and are only merged when they are both on the same baseline AND horizontally
 * adjacent. The adjacency test is what prevents text from the left column
 * merging with text from the right column just because they share a y value.
 */
export function assembleLines(items: PositionedItem[]): Line[] {
  const lines: Line[] = [];

  let cur: {
    parts: string[];
    x: number;
    xEnd: number;
    y: number;
    fontSize: number;
    isBullet: boolean;
    wasSpaced: boolean;
    anchors: number[];
  } | null = null;

  const flush = () => {
    if (!cur) return;
    const text = normalizeSpacing(cur.parts.join('').replace(/\s+/g, ' ').trim());
    if (text) {
      lines.push({
        text,
        x: cur.x,
        xEnd: cur.xEnd,
        y: cur.y,
        fontSize: cur.fontSize,
        isBullet: cur.isBullet,
        wasSpaced: cur.wasSpaced,
        anchors: cur.anchors,
      });
    }
    cur = null;
  };

  for (const raw of items) {
    if (!raw.str || !raw.str.trim()) continue;

    const { text: str, wasSpaced } = collapseLetterSpacing(raw.str);
    const fontSize = raw.fontSize || 12;

    // Continuation is tested BEFORE bullet detection. Otherwise a hyphen inside
    // a word split across items ("self" + "-" + "esteem") would be mistaken for
    // a list marker and shatter the line into fragments.
    if (cur) {
      const sameBaseline = Math.abs(raw.y - cur.y) <= fontSize * BASELINE_TOLERANCE_RATIO;
      const gap = raw.x - cur.xEnd;
      const adjacent = gap <= fontSize * SAME_LINE_GAP_RATIO;

      if (sameBaseline && adjacent && gap > -fontSize) {
        const prevText = cur.parts[cur.parts.length - 1] ?? '';
        const joiner = shouldJoinWithoutSpace(prevText, str, gap, fontSize) ? '' : ' ';
        // Empty parts means only a bullet glyph is pending, so no joiner yet.
        cur.parts.push(cur.parts.length === 0 ? str : joiner + str);
        cur.xEnd = raw.x + raw.width;
        cur.fontSize = Math.max(cur.fontSize, fontSize);
        // The flag reflects how the line STARTS. A letter-spaced heading often
        // ends with normal-spaced text ("SENSORIMOTOR" + "(0-2 yr)"), and
        // downgrading here would lose the heading signal entirely.
        cur.anchors.push(raw.x);
        continue;
      }
      flush();
    }

    // A standalone bullet glyph starting a fresh line: record it as a flag.
    if (BULLET_RE.test(str) && raw.width < fontSize * 1.2) {
      cur = {
        parts: [],
        x: raw.x,
        xEnd: raw.x + raw.width,
        y: raw.y,
        fontSize,
        isBullet: true,
        wasSpaced: false,
        anchors: [],
      };
      continue;
    }

    cur = {
      parts: [str],
      x: raw.x,
      xEnd: raw.x + raw.width,
      y: raw.y,
      fontSize,
      isBullet: false,
      wasSpaced,
      anchors: [raw.x],
    };
  }
  flush();

  return lines;
}

// ---------------------------------------------------------------------------
// Step 3: table detection
// ---------------------------------------------------------------------------

function clusterValues(values: number[], tolerance: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const v of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && v - last[last.length - 1] <= tolerance) last.push(v);
    else clusters.push([v]);
  }
  return clusters.map((c) => c.reduce((s, v) => s + v, 0) / c.length);
}

/**
 * Finds x positions that recur down the page. In a real table every row starts
 * its cells at the same handful of x values, so anchors that appear on many
 * distinct baselines are almost certainly column starts.
 */
function detectColumnAnchors(lines: Line[]): number[] {
  const xs = lines.map((l) => l.x);
  const candidates = clusterValues(xs, COLUMN_ANCHOR_TOLERANCE);

  const scored = candidates
    .map((anchor) => {
      const rows = new Set(
        lines
          .filter((l) => Math.abs(l.x - anchor) <= COLUMN_ANCHOR_TOLERANCE)
          .map((l) => Math.round(l.y))
      );
      return { anchor, count: rows.size };
    })
    .filter((c) => c.count >= MIN_TABLE_ROWS)
    .sort((a, b) => a.anchor - b.anchor);

  return scored.map((s) => s.anchor);
}

function assignColumn(x: number, anchors: number[]): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < anchors.length; i++) {
    const d = Math.abs(x - anchors[i]);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * Groups lines into table rows by column occupancy.
 *
 * Gap statistics alone cannot do this: in a table whose cells all fit on one
 * line, every vertical gap is identical, so there is no "large gap" to split
 * on. Instead a new row starts when a line lands in a column the current row
 * has already filled — unless it sits close enough vertically to be a wrapped
 * continuation of that same cell. The wrap threshold is derived from the font
 * size rather than from the gaps, which keeps it stable in both cases.
 */
function groupIntoRows(lines: Line[], anchors: number[]): Line[][] {
  const ordered = [...lines].sort((a, b) => b.y - a.y);
  if (ordered.length === 0) return [];

  const bands: Line[][] = [];
  let current: Line[] = [];
  let lastInColumn = new Map<number, Line>();

  for (const line of ordered) {
    const col = assignColumn(line.x, anchors);
    const occupant = lastInColumn.get(col);
    const wrapThreshold = line.fontSize * 1.6;

    const isWrapOfSameCell = occupant && occupant.y - line.y <= wrapThreshold;

    if (occupant && !isWrapOfSameCell) {
      bands.push(current);
      current = [];
      lastInColumn = new Map();
    }

    current.push(line);
    lastInColumn.set(col, line);
  }

  if (current.length > 0) bands.push(current);
  return bands;
}

interface TableCandidate {
  headers: string[];
  rows: string[][];
  consumed: Set<Line>;
}

function tryExtractTable(lines: Line[]): TableCandidate | null {
  // Bulleted content is a panel layout (side-by-side text boxes), not a grid.
  // Slides use both, and mistaking one for the other scrambles the content.
  if (lines.some((l) => l.isBullet)) return null;

  const anchors = detectColumnAnchors(lines);
  // Two anchors is far more often a two-column layout than a real table, so a
  // genuine grid is required to have at least three columns.
  if (anchors.length < 3) return null;

  const rows = groupIntoRows(lines, anchors);
  // Rows that actually populate multiple columns.
  const gridRows = rows.filter((rowLines) => {
    const cols = new Set(rowLines.map((l) => assignColumn(l.x, anchors)));
    return cols.size >= Math.min(anchors.length, 2);
  });

  if (gridRows.length < MIN_TABLE_ROWS) return null;

  const consumed = new Set<Line>();
  const materialized: string[][] = [];

  for (const rowLines of gridRows) {
    const cells: string[][] = anchors.map(() => []);
    // Preserve top-to-bottom order for wrapped cell text.
    const ordered = [...rowLines].sort((a, b) => b.y - a.y);
    for (const line of ordered) {
      cells[assignColumn(line.x, anchors)].push(stripBullet(line.text));
      consumed.add(line);
    }
    materialized.push(cells.map((c) => c.join(' ').replace(/\s+/g, ' ').trim()));
  }

  const [headers, ...body] = materialized;
  if (!headers || body.length < MIN_TABLE_ROWS) return null;

  // A real header row is a complete set of short column labels.
  const headerLooksReal =
    headers.every((h) => h.length > 0 && h.length <= 60) &&
    headers.every((h) => !/[.!?]$/.test(h));
  if (!headerLooksReal) return null;

  // Body rows should populate nearly every cell; a panel layout will not.
  const filled = body.flat().filter(Boolean).length / (body.length * headers.length);
  if (filled < 0.85) return null;

  return { headers, rows: body, consumed };
}

// ---------------------------------------------------------------------------
// Step 4: block segmentation for non-table content
// ---------------------------------------------------------------------------

function stripBullet(text: string): string {
  return text.replace(LEADING_BULLET_RE, '').replace(/^\d+[.)]\s+/, '').trim();
}

function endsMidSentence(text: string): boolean {
  return !/[.!?:;]$/.test(text.trim());
}

/** Rejoins a bullet or paragraph that wrapped onto the following visual line. */
interface Entry {
  text: string;
  isBullet: boolean;
  fontSize: number;
  x: number;
  y: number;
  wasSpaced: boolean;
}

function rejoinWrapped(lines: Line[]): Entry[] {
  const out: Entry[] = [];

  for (const line of lines) {
    const text = stripBullet(line.text);
    if (!text) continue;

    const prev = out[out.length - 1];
    const isContinuation =
      prev &&
      !line.isBullet &&
      // A spaced line may continue another spaced line (a wrapped heading), but
      // a spaced/unspaced mismatch means the two lines play different roles.
      line.wasSpaced === prev.wasSpaced &&
      // Continuation lines are indented to match the text, not the bullet.
      line.x > prev.x - 2 &&
      Math.abs(line.fontSize - prev.fontSize) < 1.5 &&
      endsMidSentence(prev.text) &&
      // Body text continues in lowercase; a wrapped all-caps heading does not.
      (line.wasSpaced ? /^[A-Z0-9]/.test(text) : /^[a-z0-9("'\u2018\u201c]/.test(text));

    if (isContinuation) {
      prev.text = `${prev.text} ${text}`.replace(/\s+/g, ' ');
      continue;
    }

    out.push({
      text,
      isBullet: line.isBullet,
      fontSize: line.fontSize,
      x: line.x,
      y: line.y,
      wasSpaced: line.wasSpaced,
    });
  }

  return out;
}

function segmentBlocks(
  lines: Line[],
  titleSize: number,
  bodySize: number
): Block[] {
  const blocks: Block[] = [];
  const entries = rejoinWrapped(lines);

  let pendingHeading: string | undefined;
  let listBuffer: string[] = [];
  let paraBuffer: string[] = [];

  const flushList = () => {
    if (listBuffer.length > 0) {
      blocks.push({ kind: 'list', heading: pendingHeading, items: [...listBuffer] });
      listBuffer = [];
      // The heading belongs to the list we just emitted; it must not carry over
      // to the next one, or unrelated bullets inherit a wrong label.
      pendingHeading = undefined;
    }
  };
  const flushPara = () => {
    if (paraBuffer.length > 0) {
      blocks.push({ kind: 'paragraph', text: paraBuffer.join(' '), heading: pendingHeading });
      paraBuffer = [];
      pendingHeading = undefined;
    }
  };

  let prevEntry: Entry | null = null;

  for (const entry of entries) {
    // A large vertical gap, or a jump back up the page (a new column), ends the
    // current paragraph. Without this, the next panel's opening line gets glued
    // onto the tail of the previous panel's text.
    if (prevEntry) {
      const movedUp = entry.y > prevEntry.y + entry.fontSize;
      // Consecutive bullets are exempt from the gap test: a bullet that wrapped
      // onto a second line leaves a large gap to the next bullet, and splitting
      // there would shatter one list into several.
      const consecutiveBullets = entry.isBullet && prevEntry.isBullet;
      const gap = prevEntry.y - entry.y;
      const bigGap = !consecutiveBullets && gap > entry.fontSize * BLOCK_BREAK_RATIO;
      // A completed sentence plus a clearly enlarged gap is also a boundary,
      // which keeps distinct labelled facts from merging. The threshold sits
      // above normal line leading so ordinary multi-sentence prose stays whole.
      const sentenceBoundary =
        !consecutiveBullets &&
        gap > entry.fontSize * 1.4 &&
        /[.!?]["')\]]?$/.test(paraBuffer[paraBuffer.length - 1] ?? '');

      if (movedUp || bigGap || sentenceBoundary) {
        flushList();
        flushPara();
      }
    }
    prevEntry = entry;

    const isHeading =
      !entry.isBullet &&
      // Real headings are short. A long line only looks heading-sized because
      // this page's modal font came from small print (a sidebar or nav list);
      // treating wrapped body prose as a heading shatters the paragraph.
      (entry.wasSpaced ? entry.text.length < 90 : entry.text.length <= 60) &&
      // Either visually larger than body text, or letter-spaced (slide decks
      // often set section headers at body size but with wide tracking).
      ((entry.fontSize > bodySize + 0.75 && entry.fontSize < titleSize - 0.5) || entry.wasSpaced);

    // "Common features:" style inline labels also act as list headings.
    const isInlineLabel =
      !entry.isBullet && /^[^.!?]{3,60}:$/.test(entry.text) && entry.text.length < 70;

    if (isHeading || isInlineLabel) {
      flushList();
      flushPara();
      if (isHeading) {
        blocks.push({ kind: 'heading', text: entry.text.replace(/:$/, ''), level: 2 });
        // A real heading is emitted as its own block, so it must not also be
        // attached to the next paragraph as an inline label — that would make
        // the consumer treat a section heading as a "Term:" construction.
        pendingHeading = undefined;
      } else {
        pendingHeading = entry.text.replace(/:$/, '');
      }
      continue;
    }

    if (entry.isBullet) {
      flushPara();
      listBuffer.push(entry.text);
      continue;
    }

    flushList();
    paraBuffer.push(entry.text);
  }

  flushList();
  flushPara();

  return blocks;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Lines produced by the browser's print chrome rather than by the document:
 * page counters, source URLs, and print timestamps. These appear on every page
 * of a web-printed PDF and carry no study value.
 */
const PRINT_ARTIFACT_RE = [
  /^\d+\s+of\s+\d+$/i,
  /^page\s+\d+(\s+of\s+\d+)?$/i,
  /^https?:\/\//i,
  /^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(\s*[AP]M)?$/i,
  /^©\s*\d{4}/,
];

function isPrintArtifact(text: string): boolean {
  const t = text.trim();
  return PRINT_ARTIFACT_RE.some((re) => re.test(t));
}

export function analyzePage(items: PositionedItem[], label: string): DocumentSection {
  const allLines = assembleLines(items);
  const lines = allLines.filter((l) => !isPrintArtifact(l.text));
  if (lines.length === 0) return { label, blocks: [] };

  const sizes = lines.map((l) => l.fontSize);
  const titleSize = Math.max(...sizes);
  // Modal font size ≈ body text.
  const freq = new Map<number, number>();
  for (const s of sizes) {
    const k = Math.round(s * 2) / 2;
    freq.set(k, (freq.get(k) ?? 0) + 1);
  }
  const bodySize = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];

  // The largest line, if clearly larger than body text, is the page title.
  const titleLine = lines.find((l) => l.fontSize === titleSize && l.text.length > 2);
  const hasTitle = !!titleLine && titleSize > bodySize + 2;
  const title = hasTitle ? titleLine!.text : undefined;

  const rest = lines.filter((l) => l !== titleLine);

  const blocks: Block[] = [];
  if (title) blocks.push({ kind: 'heading', text: title, level: 1 });

  const table = tryExtractTable(rest);
  if (table) {
    blocks.push({ kind: 'table', headers: table.headers, rows: table.rows, context: title });
    const leftovers = rest.filter((l) => !table.consumed.has(l));
    blocks.push(...segmentBlocks(leftovers, titleSize, bodySize));
  } else {
    blocks.push(...segmentBlocks(rest, titleSize, bodySize));
  }

  for (const b of blocks) {
    if (b.kind !== 'heading' && !b.context) b.context = title;
  }

  return { label, title, blocks };
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
    [...counts.entries()].filter(([, n]) => n >= threshold).map(([t]) => t)
  );

  // Printed web pages repeat the document's own section list in a sidebar or
  // page footer. Those entries are titles of OTHER sections, so any short block
  // whose text matches a different section's title is navigation, not content.
  const titles = new Map<string, string>();
  for (const s of sections) {
    if (s.title) titles.set(normalizeTitle(s.title), s.label);
  }

  return sections.map((section) => ({
    ...section,
    blocks: section.blocks.filter((b) => {
      if (furniture.has(blockSignature(b))) return false;
      if (b.kind !== 'paragraph' && b.kind !== 'heading') return true;
      const text = b.kind === 'paragraph' ? b.text : b.text;
      if (text.length > 60) return true;
      const owner = titles.get(normalizeTitle(text));
      return !owner || owner === section.label;
    }),
  }));
}

function normalizeTitle(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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
