import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { sectionsFromDocument } from '../src/lib/htmlParser.ts';
import { generateCandidates } from '../src/lib/flashcardGenerator.ts';

/**
 * Runs the real HTML parser over a page.
 *
 * Node has no DOM, so `linkedom` stands in for the browser's DOMParser here;
 * the app itself uses the browser's own and ships no HTML parser.
 *
 *   node --experimental-strip-types --experimental-loader ./tools/ts-ext-hooks.mjs \
 *     tools/test-html.mjs page.html
 *   URL=https://example.com/page node ... tools/test-html.mjs
 */
const source = process.env.URL
  ? await fetch(process.env.URL).then((r) => r.text())
  : fs.readFileSync(process.argv[2], 'utf8');

const { document } = parseHTML(source);
const sections = sectionsFromDocument(document);

console.log(`SECTIONS: ${sections.length}\n`);
for (const s of sections) {
  console.log(`───────── ${s.label}${s.title ? ` — ${s.title}` : ''} ─────────`);
  for (const b of s.blocks) {
    if (b.kind === 'heading') console.log(`  [h${b.level}] ${b.text}`);
    else if (b.kind === 'list') console.log(`  [list${b.heading ? ` @${b.heading}` : ''}] ${b.items.join(' | ').slice(0, 140)}`);
    else if (b.kind === 'table') console.log(`  [table] ${b.headers.join(' / ')} (${b.rows.length} rows)`);
    else if (b.kind === 'code')
      console.log(`  [code ${b.language ?? '?'}] ${b.text.split(/\n/)[0].slice(0, 70)} … (${b.text.length} chars)`);
    else console.log(`  [para] ${b.text.slice(0, 130)}`);
  }
  console.log('');
}

const payload = JSON.stringify(sections).length;
console.log(`PAYLOAD: ${payload} chars across ${Math.ceil(sections.length / 4)} AI batches\n`);

const cards = generateCandidates(sections);
console.log(`RULE-BASED CARDS: ${cards.length}`);
