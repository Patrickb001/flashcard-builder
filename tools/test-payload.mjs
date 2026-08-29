import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import { analyzePage, stripRepeatedFurniture } from '../src/lib/layoutAnalysis.ts';
import { parseCardsResponse } from '../src/lib/cardPrompt.ts';

const path = process.env.PDF || '/mnt/user-data/uploads/TypeScript__Documentation_-_Everyday_Types.pdf';
const pdf = await getDocument({ data: new Uint8Array(fs.readFileSync(path)), useSystemFonts: true }).promise;
const sections = [];
for (let p = 1; p <= pdf.numPages; p++) {
  const page = await pdf.getPage(p);
  const tc = await page.getTextContent();
  sections.push(analyzePage(tc.items.filter(i => 'str' in i).map(i => ({
    str: i.str, x: i.transform[4], y: i.transform[5],
    width: i.width ?? 0, fontSize: Math.hypot(i.transform[2], i.transform[3]),
  })), `Page ${p}`));
}
const clean = stripRepeatedFurniture(sections);

const serialize = (s) => ({
  source: s.label, title: s.title ?? null,
  blocks: s.blocks.map(b => b.kind === 'heading' ? { type:'heading', level:b.level, text:b.text }
    : b.kind === 'paragraph' ? { type:'paragraph', label:b.heading ?? null, text:b.text }
    : b.kind === 'list' ? { type:'list', label:b.heading ?? null, items:b.items }
    : { type:'table', headers:b.headers, rows:b.rows }),
});

const batch = clean.slice(0, 4).map(serialize);
const json = JSON.stringify(batch);
console.log('batch chars:', json.length);
console.log('total batches:', Math.ceil(clean.length / 4));
console.log('largest batch chars:', Math.max(...Array.from({length: Math.ceil(clean.length/4)},
  (_,i) => JSON.stringify(clean.slice(i*4,(i+1)*4).map(serialize)).length)));
console.log('\nSample payload (truncated):\n', json.slice(0, 700));

// Parser robustness
const cases = [
  '[{"front":"A","back":"B","context":"C"}]',
  '```json\n[{"front":"A","back":"B"}]\n```',
  'Here you go:\n[{"front":"A","back":"B"}]\nHope that helps!',
  'not json at all',
  '[]',
];
console.log('\nparser results:', cases.map(c => parseCardsResponse(c).length));
