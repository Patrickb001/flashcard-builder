import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import { analyzePage } from '../src/lib/layoutAnalysis.ts';
import { stripRepeatedFurniture } from '../src/lib/sectioning.ts';
import { generateCandidates } from '../src/lib/flashcardGenerator.ts';

const path = process.env.PDF || '/mnt/user-data/uploads/W1_Lecture_Lifespan_Development_1_-_Tagged.pdf';
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

const cards = generateCandidates(stripRepeatedFurniture(sections));
console.log(`TOTAL CARDS: ${cards.length}\n`);

let last = '';
for (const c of cards) {
  if (c.sourceLabel !== last) {
    console.log(`\n───────── ${c.sourceLabel} ─────────`);
    last = c.sourceLabel;
  }
  console.log(`Q: ${c.front}${c.context ? `   [${c.context}]` : ""}`);
  console.log(`A: ${c.back.replace(/\n/g, '\n   ')}\n`);
}
