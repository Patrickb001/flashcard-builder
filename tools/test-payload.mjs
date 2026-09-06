import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import { requirePdfPath } from './pdfPath.mjs';
import { analyzePage } from '../src/lib/layoutAnalysis.ts';
import { stripRepeatedFurniture } from '../src/lib/sectioning.ts';
import { parseCardsResponse } from '../src/lib/cardPrompt.ts';

const path = requirePdfPath();
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
  ['well-formed', '[{"front":"A","back":"B","context":"C"}]', 1],
  ['fenced', '```json\n[{"front":"A","back":"B"}]\n```', 1],
  ['chatty', 'Here you go:\n[{"front":"A","back":"B"}]\nHope that helps!', 1],
  ['not json', 'not json at all', 0],
  ['empty array', '[]', 0],

  // The regression this file exists for. A dense page asks for more cards than
  // the response ceiling holds, and the reply ends mid-object with no closing
  // bracket. This used to return 0 — the whole page fell back to rule-based
  // cards despite most of its cards having arrived intact.
  [
    'truncated mid-object',
    '[{"front":"A","back":"1"},{"front":"B","back":"2"},{"front":"C","back":"in',
    2,
  ],
  [
    'truncated after a complete object',
    '[{"front":"A","back":"1"},{"front":"B","back":"2"},',
    2,
  ],
  // A brace inside a value must not end the object early.
  [
    'braces inside strings, truncated',
    '[{"front":"What does {x:1} mean?","back":"An object"},{"front":"D","back":"cut',
    1,
  ],
  // source is echoed back so a card lands on the page it came from.
  [
    'source echoed',
    '[{"source":"Page 7","front":"A","back":"B"}]',
    1,
  ],
];

let failures = 0;
console.log('\nparser results:');
for (const [name, input, expected] of cases) {
  const got = parseCardsResponse(input).length;
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(32)} expected ${expected}, got ${got}`);
}

const sourced = parseCardsResponse('[{"source":"Page 7","front":"A","back":"B"}]')[0];
if (sourced?.source !== 'Page 7') {
  failures++;
  console.log(`  FAIL source not parsed: ${JSON.stringify(sourced?.source)}`);
}

console.log(failures === 0 ? '\nPASS: parser handles every case.' : `\nFAIL: ${failures} case(s).`);
process.exit(failures === 0 ? 0 : 1);
