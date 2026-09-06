import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { sectionsFromDocument } from '../src/lib/htmlParser.ts';
import { generateCandidates } from '../src/lib/flashcardGenerator.ts';

/**
 * Pins the HTML parser's output over six real pages.
 *
 * This is the safety net for the consolidation refactor: the parser is being
 * moved between files and split up, and none of that may change what it
 * produces. The fixtures are the article region of six GeeksforGeeks pages,
 * trimmed to the element `findContentRoot` already selects so the trim itself
 * cannot alter the parse.
 *
 *   node --experimental-strip-types --import ./tools/register.mjs \
 *     tools/test-golden.mjs [--update]
 *
 * `--update` rewrites the recorded output. Only run it when a change to what
 * the parser produces is intended, and read the resulting diff.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = path.join(HERE, 'fixtures', 'pages');
const GOLDEN_DIR = path.join(HERE, 'fixtures', 'golden');

/** short name -> source URL, needed so relative image srcs resolve as they did live. */
const PAGES = [
  ['class-and-object', 'https://www.geeksforgeeks.org/class-and-object-for-data-structure/'],
  ['conditional-statements', 'https://www.geeksforgeeks.org/conditional-statements-in-programming/'],
  ['for-loop', 'https://www.geeksforgeeks.org/for-loop-in-programming/'],
  ['functions', 'https://www.geeksforgeeks.org/functions-in-programming/'],
  ['input-and-output', 'https://www.geeksforgeeks.org/input-and-output-in-programming/'],
  ['while-loop', 'https://www.geeksforgeeks.org/while-loop-in-programming/'],
];

const update = process.argv.includes('--update');
fs.mkdirSync(GOLDEN_DIR, { recursive: true });

/** First path at which two parsed snapshots differ, or null. */
function firstDiff(a, b, at = '') {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null) return { at, a, b };
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return { at: at + '.length', a: a.length, b: b.length };
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], at + '[' + i + ']');
      if (d) return d;
    }
    return null;
  }
  if (typeof a === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], at + '.' + k);
      if (d) return d;
    }
    return null;
  }
  return { at, a, b };
}

let failures = 0;
for (const [name, baseUrl] of PAGES) {
  const source = fs.readFileSync(path.join(PAGES_DIR, name + '.html'), 'utf8');
  const { document } = parseHTML(source);
  const sections = sectionsFromDocument(document, { baseUrl });
  const cards = generateCandidates(sections);
  const actual = { sections, cards };

  const goldenPath = path.join(GOLDEN_DIR, name + '.json');
  if (update || !fs.existsSync(goldenPath)) {
    fs.writeFileSync(goldenPath, JSON.stringify(actual, null, 2) + '\n', 'utf8');
    console.log(`  rec  ${name.padEnd(24)} ${sections.length} sections, ${cards.length} cards`);
    continue;
  }

  const expected = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
  const diff = firstDiff(JSON.parse(JSON.stringify(actual)), expected);
  if (diff) {
    failures++;
    console.log(`  FAIL ${name.padEnd(24)} first difference at ${diff.at}`);
    console.log(`         got:      ${JSON.stringify(diff.a).slice(0, 160)}`);
    console.log(`         expected: ${JSON.stringify(diff.b).slice(0, 160)}`);
  } else {
    console.log(`  ok   ${name.padEnd(24)} ${sections.length} sections, ${cards.length} cards`);
  }
}

console.log('');
if (update) console.log('Golden output recorded.');
else if (failures) { console.log(`${failures} page(s) changed.`); process.exit(1); }
else console.log('All six pages match the recorded parser output.');
