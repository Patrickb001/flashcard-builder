import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import { analyzePage } from '../src/lib/layoutAnalysis.ts';
import { stripRepeatedFurniture } from '../src/lib/sectioning.ts';
import { estimateCards, generateCandidatesWithAi } from '../src/lib/aiGenerator.ts';

/**
 * Drafts a whole PDF with the real model and reports the coverage.
 *
 * This is the check that the batching and salvage work in tools/test-payload
 * and tools/test-ai-batching cannot make: whether every page of a real document
 * actually comes back with cards. A 16-page clinical deck used to lose three
 * batches of four to the response ceiling and fall back to rule-based cards for
 * most of the document, and nothing in the pure tests could see that.
 *
 *   PDF="…/W3_Lecture_Depressive_Bipolar_STUDENT - Tagged.pdf" \
 *     node --experimental-strip-types --loader ./tools/ts-ext-hooks.mjs tools/test-ai-cards.mjs
 *
 * Calls the model, so it costs real money and only runs with a key present.
 */

const path = process.env.PDF;
if (!path) {
  console.error('Set PDF=/path/to/file.pdf');
  process.exit(1);
}

function readKeyFromEnvFile() {
  try {
    return fs.readFileSync('.env', 'utf8').match(/ANTHROPIC_API_KEY=(.+)/)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

const key = process.env.ANTHROPIC_API_KEY ?? readKeyFromEnvFile();
if (!key) {
  console.log('Skipped — set ANTHROPIC_API_KEY to run it.');
  process.exit(0);
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
console.log(`Drafting ${clean.length} sections from ${path}\n`);

const result = await generateCandidatesWithAi(
  clean,
  { mode: 'byok', apiKey: key },
  { onProgress: (p) => process.stdout.write(`\r  batch ${p.done} of ${p.total}   `) }
);

console.log(`\n\n${result.cards.length} cards`);
console.log(`  batches:    ${result.totalBatches} (${result.failedBatches} failed)`);
console.log(`  truncated:  ${result.truncatedBatches}`);
console.log(`  fell back:  ${result.failedSections.length ? result.failedSections.join(', ') : 'none'}`);
if (result.firstError) console.log(`  first error: ${result.firstError}`);

// Coverage per page. The bug this guards against was invisible in the totals:
// the deck filled up, but three quarters of it came from the rule-based
// generator and every card carried the wrong page number.
const byLabel = new Map();
for (const card of result.cards) {
  byLabel.set(card.sourceLabel, (byLabel.get(card.sourceLabel) ?? 0) + 1);
}

/**
 * Pages with real content that produced nothing.
 *
 * An empty page is not automatically wrong: the prompt tells the model to
 * return nothing for a section with nothing worth learning, and a title slide
 * or a "Learning Objectives" list taking that option is the prompt working —
 * the card validator rejects those fronts as boilerplate anyway. What would be
 * wrong is a page dense enough to be worth ten cards coming back empty, which
 * is what silent truncation looked like.
 */
const DENSE = 10;

console.log('\nCards per page:');
const emptyDense = [];
for (const section of clean) {
  const n = byLabel.get(section.label) ?? 0;
  const est = estimateCards(section);
  if (n === 0 && est >= DENSE) emptyDense.push(section.label);
  console.log(
    `  ${section.label.padEnd(9)} ${String(n).padStart(3)} card(s)  (est ${String(est).padStart(2)})  ${section.title ?? ''}`
  );
}

const stray = [...byLabel.keys()].filter((l) => !clean.some((s) => s.label === l));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`);
};

console.log('\nASSERTIONS');
check('no page fell back to rule-based drafting', result.failedSections.length === 0, result.failedSections.join(', '));
check('no batch was cut off by the ceiling', result.truncatedBatches === 0, `${result.truncatedBatches} truncated`);
check('every card names a real page', stray.length === 0, stray.join(', '));
check('cards are spread across the document', byLabel.size > clean.length / 2, `only ${byLabel.size} of ${clean.length} pages have cards`);
check('no content-dense page came back empty', emptyDense.length === 0, emptyDense.join(', '));

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
