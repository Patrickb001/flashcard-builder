import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import { analyzePage } from '../src/lib/layoutAnalysis.ts';
import { stripRepeatedFurniture } from '../src/lib/sectioning.ts';
import { buildBatches, estimateCards } from '../src/lib/aiGenerator.ts';

/**
 * How a real document is split into requests.
 *
 * The failure this guards against is invisible from the outside: a batch that
 * asks the model for more cards than the response ceiling can hold comes back
 * truncated, and before the salvage parser existed that lost the whole batch.
 * A 16-page clinical deck lost three batches of four this way. So the thing
 * worth asserting is not that batching runs, but that no batch is aimed at
 * more cards than one reply can carry.
 *
 *   PDF="…/W3_Lecture_Depressive_Bipolar_STUDENT - Tagged.pdf" \
 *     node --experimental-strip-types --import ./tools/register.mjs tools/test-ai-batching.mjs
 */

const path = process.env.PDF;
if (!path) {
  console.error('Set PDF=/path/to/file.pdf');
  process.exit(1);
}

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

const clean = stripRepeatedFurniture(sections);
console.log(`${clean.length} sections from ${pdf.numPages} pages\n`);

console.log('Estimated cards per section:');
for (const s of clean) {
  console.log(`  ${s.label.padEnd(9)} ${String(estimateCards(s)).padStart(3)}  ${s.title ?? ''}`);
}

const MAX_BATCH_CARDS = 40;
const batches = buildBatches(clean, 4);

console.log(`\n${batches.length} batches (was ${Math.ceil(clean.length / 4)} under fixed-4 batching):`);
let overshoot = 0;
for (const [i, batch] of batches.entries()) {
  const cost = batch.reduce((n, s) => n + estimateCards(s), 0);
  const over = cost > MAX_BATCH_CARDS && batch.length > 1;
  if (over) overshoot++;
  console.log(
    `  ${String(i + 1).padStart(2)}. ${batch.map((s) => s.label).join(', ').padEnd(34)} ~${String(cost).padStart(3)} cards${over ? '   <-- OVER BUDGET' : ''}`
  );
}

// A lone section worth more than the budget is allowed through: there is
// nothing smaller to split it into. A multi-section batch over budget is a bug.
console.log(
  overshoot === 0
    ? '\nPASS: no multi-section batch exceeds the yield budget.'
    : `\nFAIL: ${overshoot} multi-section batch(es) over budget.`
);
process.exit(overshoot === 0 ? 0 : 1);
