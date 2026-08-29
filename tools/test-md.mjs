import fs from 'node:fs';
import { parseMarkdownSections } from '../src/lib/markdownParser.ts';
import { generateCandidates } from '../src/lib/flashcardGenerator.ts';

const path = process.env.MD || process.argv[2];
if (!path) {
  console.error(
    'Usage: node --experimental-strip-types --experimental-loader ./tools/ts-ext-hooks.mjs tools/test-md.mjs <file.md>'
  );
  process.exit(1);
}

const sections = parseMarkdownSections(fs.readFileSync(path, 'utf8'), path.split(/[\/]/).pop());

console.log(`SECTIONS: ${sections.length}\n`);
for (const s of sections) {
  console.log(`───────── ${s.label}${s.title ? ` — ${s.title}` : ''} ─────────`);
  for (const b of s.blocks) {
    if (b.kind === 'heading') console.log(`  [h${b.level}] ${b.text}`);
    else if (b.kind === 'list') console.log(`  [list${b.heading ? ` @${b.heading}` : ''}] ${b.items.join(' | ')}`);
    else if (b.kind === 'table') console.log(`  [table] ${b.headers.join(' / ')} (${b.rows.length} rows)`);
    else if (b.kind === 'code')
      console.log(
        `  [code ${b.language ?? '?'}${b.heading ? ` @${b.heading}` : ''}] ${b.text.split(/\n/)[0].slice(0, 80)} … (${b.text.length} chars)`
      );
    else console.log(`  [para${b.heading ? ` @${b.heading}` : ''}] ${b.text.slice(0, 120)}`);
  }
  console.log('');
}

const payload = JSON.stringify(sections).length;
console.log(`PAYLOAD: ${payload} chars across ${Math.ceil(sections.length / 4)} AI batches
`);

const cards = generateCandidates(sections);
console.log(`TOTAL CARDS: ${cards.length}\n`);
let last = '';
for (const c of cards) {
  if (c.sourceLabel !== last) {
    console.log(`\n───────── ${c.sourceLabel} ─────────`);
    last = c.sourceLabel;
  }
  console.log(`Q: ${c.front}${c.context ? `   [${c.context}]` : ''}`);
  console.log(`A: ${c.back.replace(/\n/g, '\n   ')}\n`);
}
