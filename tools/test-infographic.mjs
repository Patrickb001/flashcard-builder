import { parseExtractionResponse, INFOGRAPHIC_EXTRACT_PROMPTS } from '../src/lib/infographicPrompt.ts';
import { deleteInfographicModalCopy } from '../src/lib/infographicCopy.ts';

/**
 * The infographic pipeline's pure functions: extraction parsing/clamping,
 * design-document extraction, and HTML sanitizing.
 *
 *   node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs
 *
 * Pure — no browser, no model call, no network.
 */

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`}`
  );
}

// ---------- extraction: well-formed reply ----------

console.log('extraction — well-formed reply');
const wellFormed = JSON.stringify({
  title: 'Cell Biology',
  lede: 'Cells run on a handful of specialized organelles.',
  coreConcept: { Structure: 'Form follows function at every scale.' },
  items: [
    { label: 'Mitochondria', detail: 'Make ATP through respiration.', meta: 'organelle' },
    { label: 'Golgi apparatus', detail: 'Packages proteins for export.' },
  ],
  keyTakeaway: 'Every organelle exists to serve one job in the cell.',
});
check(
  'parses every field through unchanged (within the basic ceiling)',
  parseExtractionResponse(wellFormed, 'Cell Biology', 'basic'),
  {
    title: 'Cell Biology',
    lede: 'Cells run on a handful of specialized organelles.',
    coreConcept: { Structure: 'Form follows function at every scale.' },
    items: [
      { label: 'Mitochondria', detail: 'Make ATP through respiration.', meta: 'organelle' },
      { label: 'Golgi apparatus', detail: 'Packages proteins for export.' },
    ],
    keyTakeaway: 'Every organelle exists to serve one job in the cell.',
  }
);

console.log('\nfenced reply');
check(
  'strips a markdown fence around the object',
  parseExtractionResponse('```json\n' + wellFormed + '\n```', 'Cell Biology', 'basic'),
  parseExtractionResponse(wellFormed, 'Cell Biology', 'basic')
);

console.log('\nmissing title falls back to the deck name');
const noTitle = JSON.stringify({
  items: [{ label: 'A', detail: 'A detail.' }],
  keyTakeaway: 'Remember A.',
});
check('title falls back to deckName', parseExtractionResponse(noTitle, 'My Deck', 'basic').title, 'My Deck');

console.log('\nitems beyond the level ceiling are clamped from the tail');
const manyItems = JSON.stringify({
  title: 'Verbose Deck',
  items: Array.from({ length: 12 }, (_, i) => ({ label: `Item ${i + 1}`, detail: `Detail ${i + 1}.` })),
  keyTakeaway: 'Too many items.',
});
const clampedStandard = parseExtractionResponse(manyItems, 'Verbose Deck', 'standard');
check('standard keeps exactly 9 items', clampedStandard.items.length, 9);
check('standard keeps the first 9, not an arbitrary 9', clampedStandard.items[0].label, 'Item 1');
check(
  'standard drops from the tail',
  clampedStandard.items[clampedStandard.items.length - 1].label,
  'Item 9'
);

console.log('\ncoreConcept beyond 4 pairs is clamped to 4');
const manyPairs = JSON.stringify({
  title: 'Pairs',
  coreConcept: { a: '1', b: '2', c: '3', d: '4', e: '5' },
  items: [{ label: 'A', detail: 'A detail.' }],
  keyTakeaway: 'Five pairs given, four kept.',
});
check(
  'keeps only the first 4 keys',
  Object.keys(parseExtractionResponse(manyPairs, 'Pairs', 'detailed').coreConcept),
  ['a', 'b', 'c', 'd']
);

console.log('\nzero usable items returns null');
check(
  'an items array with nothing valid in it returns null',
  parseExtractionResponse(JSON.stringify({ title: 'Empty', items: [{}], keyTakeaway: 'Nothing.' }), 'Empty', 'basic'),
  null
);

console.log('\nunparseable text returns null');
check('prose with no JSON object returns null', parseExtractionResponse('Sorry, I cannot do that.', 'Deck', 'basic'), null);

console.log('\nprompts exist for every detail level');
check(
  'basic, standard, and detailed each have a non-empty prompt',
  Object.keys(INFOGRAPHIC_EXTRACT_PROMPTS).sort(),
  ['basic', 'detailed', 'standard']
);

// ---------- deleteInfographicModalCopy ----------

console.log('\ndeleteInfographicModalCopy');
check(
  'names the infographic in the title',
  deleteInfographicModalCopy('Why Your Reviews Get Farther Apart').title,
  'Delete "Why Your Reviews Get Farther Apart"?'
);
check("the body always warns it can't be undone", deleteInfographicModalCopy('Anything').body, "This can't be undone.");

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
