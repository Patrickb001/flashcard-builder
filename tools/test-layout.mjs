import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import { requirePdfPath } from './pdfPath.mjs';
import { analyzePage } from '../src/lib/layoutAnalysis.ts';
import { stripRepeatedFurniture } from '../src/lib/sectioning.ts';

const path = requirePdfPath();
const data = new Uint8Array(fs.readFileSync(path));
const pdf = await getDocument({ data, useSystemFonts: true }).promise;

const sections = [];
for (let p = 1; p <= pdf.numPages; p++) {
  const page = await pdf.getPage(p);
  const tc = await page.getTextContent();
  const items = tc.items
    .filter((i) => 'str' in i)
    .map((i) => ({
      str: i.str,
      x: i.transform[4],
      y: i.transform[5],
      width: i.width ?? 0,
      fontSize: Math.hypot(i.transform[2], i.transform[3]),
    }));
  sections.push(analyzePage(items, `Page ${p}`));
}

const cleaned = stripRepeatedFurniture(sections);

const only = process.argv[2] ? Number(process.argv[2]) : null;
for (const s of cleaned) {
  if (only && s.label !== `Page ${only}`) continue;
  console.log(`\n═══ ${s.label} — ${s.title ?? '(no title)'} ═══`);
  for (const b of s.blocks) {
    if (b.kind === 'heading') console.log(`  [H${b.level}] ${b.text}`);
    else if (b.kind === "paragraph") console.log(`  [P]${b.heading ? ` <${b.heading}>` : ""} ${b.text}`);
    else if (b.kind === 'list')
      console.log(`  [LIST${b.heading ? ` "${b.heading}"` : ''}]\n${b.items.map((i) => `      - ${i}`).join('\n')}`);
    else if (b.kind === 'table') {
      console.log(`  [TABLE] ${b.headers.join(' | ')}`);
      for (const r of b.rows) console.log(`      ${r.join(' || ')}`);
    }
  }
}
