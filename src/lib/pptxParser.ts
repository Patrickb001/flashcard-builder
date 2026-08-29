import JSZip from 'jszip';
import type { Block, DocumentSection, ListBlock } from './documentModel';
import { applyContext } from './documentModel';
import { stripRepeatedFurniture } from './sectioning';

/**
 * Reads a .pptx into structured sections.
 *
 * A .pptx is a zip of OOXML parts, and unlike a PDF it still contains the real
 * structure: shapes carry positions, tables are actual <a:tbl> elements, and
 * paragraph levels are explicit. Reading shape by shape means columns never
 * interleave, so a native .pptx generally produces better cards than the same
 * deck exported to PDF.
 */

const EMU_PER_POINT = 12700;

interface Shape {
  x: number;
  y: number;
  /** Placeholder type from the slide layout, e.g. "title" or "ctrTitle". */
  placeholder?: string;
  blocks: Block[];
}

function textOfParagraph(p: Element): string {
  const runs = p.getElementsByTagName('a:t');
  return Array.from(runs)
    .map((n) => n.textContent ?? '')
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Indentation level of a paragraph; >0 means it is a bullet. */
function paragraphLevel(p: Element): number {
  const pPr = p.getElementsByTagName('a:pPr')[0];
  if (!pPr) return 0;
  return parseInt(pPr.getAttribute('lvl') ?? '0', 10);
}

/** True when the paragraph explicitly disables bullets. */
function hasNoBullet(p: Element): boolean {
  const pPr = p.getElementsByTagName('a:pPr')[0];
  return !!pPr && pPr.getElementsByTagName('a:buNone').length > 0;
}

function firstRunSize(p: Element): number | null {
  const rPr = p.getElementsByTagName('a:rPr')[0];
  const sz = rPr?.getAttribute('sz');
  return sz ? parseInt(sz, 10) / 100 : null;
}

function parseTable(tbl: Element): Block | null {
  const rows = Array.from(tbl.getElementsByTagName('a:tr'));
  if (rows.length < 2) return null;

  const grid = rows.map((tr) =>
    Array.from(tr.getElementsByTagName('a:tc')).map((tc) =>
      Array.from(tc.getElementsByTagName('a:p'))
        .map(textOfParagraph)
        .filter(Boolean)
        .join(' ')
        .trim()
    )
  );

  const [headers, ...body] = grid;
  if (!headers || headers.length < 2 || body.length === 0) return null;
  if (headers.some((h) => !h)) return null;

  return { kind: 'table', headers, rows: body };
}

function parseTextBody(txBody: Element, isTitle: boolean): Block[] {
  const paragraphs = Array.from(txBody.getElementsByTagName('a:p'));
  const blocks: Block[] = [];

  let listBuffer: string[] = [];
  let pendingHeading: string | undefined;

  const flushList = () => {
    if (listBuffer.length > 0) {
      const list: ListBlock = { kind: 'list', heading: pendingHeading, items: [...listBuffer] };
      blocks.push(list);
      listBuffer = [];
      pendingHeading = undefined;
    }
  };

  // The largest run size in the shape marks its own internal headings.
  const sizes = paragraphs.map(firstRunSize).filter((s): s is number => s !== null);
  const maxSize = sizes.length > 0 ? Math.max(...sizes) : null;

  for (const p of paragraphs) {
    const text = textOfParagraph(p);
    if (!text) continue;

    if (isTitle) {
      blocks.push({ kind: 'heading', text, level: 1 });
      continue;
    }

    const level = paragraphLevel(p);
    const size = firstRunSize(p);
    const isBullet = level > 0 || !hasNoBullet(p);

    // A short, largest-in-shape, non-bulleted line acts as a section heading.
    const looksLikeHeading =
      !isBullet && text.length < 90 && maxSize !== null && size !== null && size >= maxSize;

    // "Common features:" style label.
    const isInlineLabel = !isBullet && /^[^.!?]{3,60}:$/.test(text);

    if (looksLikeHeading || isInlineLabel) {
      flushList();
      pendingHeading = text.replace(/:$/, '');
      if (looksLikeHeading) blocks.push({ kind: 'heading', text: pendingHeading, level: 2 });
      continue;
    }

    if (isBullet) {
      listBuffer.push(text);
      continue;
    }

    flushList();
    blocks.push({ kind: 'paragraph', text, heading: pendingHeading });
    pendingHeading = undefined;
  }

  flushList();
  return blocks;
}

function parseSlide(xmlDoc: Document, label: string): DocumentSection {
  const shapes: Shape[] = [];

  // Graphic frames hold tables.
  for (const frame of Array.from(xmlDoc.getElementsByTagName('p:graphicFrame'))) {
    const tbl = frame.getElementsByTagName('a:tbl')[0];
    if (!tbl) continue;
    const block = parseTable(tbl);
    if (!block) continue;
    const off = frame.getElementsByTagName('a:off')[0];
    shapes.push({
      x: parseInt(off?.getAttribute('x') ?? '0', 10) / EMU_PER_POINT,
      y: parseInt(off?.getAttribute('y') ?? '0', 10) / EMU_PER_POINT,
      blocks: [block],
    });
  }

  for (const sp of Array.from(xmlDoc.getElementsByTagName('p:sp'))) {
    const txBody = sp.getElementsByTagName('p:txBody')[0];
    if (!txBody) continue;

    const ph = sp.getElementsByTagName('p:ph')[0];
    const placeholder = ph?.getAttribute('type') ?? undefined;
    const isTitle = placeholder === 'title' || placeholder === 'ctrTitle';

    const blocks = parseTextBody(txBody, isTitle);
    if (blocks.length === 0) continue;

    const off = sp.getElementsByTagName('a:off')[0];
    shapes.push({
      x: parseInt(off?.getAttribute('x') ?? '0', 10) / EMU_PER_POINT,
      y: parseInt(off?.getAttribute('y') ?? '0', 10) / EMU_PER_POINT,
      placeholder,
      blocks,
    });
  }

  // Read shapes in visual order: top to bottom, then left to right. Sorting by
  // position (rather than by document order) matches how a reader works through
  // a slide, and keeps each column's content contiguous.
  shapes.sort((a, b) => {
    const titleFirst = Number(b.placeholder === 'title' || b.placeholder === 'ctrTitle') -
      Number(a.placeholder === 'title' || a.placeholder === 'ctrTitle');
    if (titleFirst !== 0) return titleFirst;
    if (Math.abs(a.y - b.y) > 24) return a.y - b.y;
    return a.x - b.x;
  });

  const blocks = shapes.flatMap((s) => s.blocks);
  const titleBlock = blocks.find((b) => b.kind === 'heading' && b.level === 1);
  const title = titleBlock && titleBlock.kind === 'heading' ? titleBlock.text : undefined;

  applyContext(blocks, title);

  return { label, title, blocks };
}

export async function extractPptxSections(file: File): Promise<DocumentSection[]> {
  const buffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buffer);

  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)\.xml/)![1], 10);
      const numB = parseInt(b.match(/slide(\d+)\.xml/)![1], 10);
      return numA - numB;
    });

  const parser = new DOMParser();
  const sections: DocumentSection[] = [];

  for (let i = 0; i < slideFiles.length; i++) {
    const xmlString = await zip.files[slideFiles[i]].async('string');
    const xmlDoc = parser.parseFromString(xmlString, 'application/xml');
    const section = parseSlide(xmlDoc, `Slide ${i + 1}`);
    if (section.blocks.length > 0) sections.push(section);
  }

  return stripRepeatedFurniture(sections);
}
