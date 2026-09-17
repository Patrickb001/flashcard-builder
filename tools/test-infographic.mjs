import {
  parseExtractionResponse,
  INFOGRAPHIC_EXTRACT_PROMPTS,
  INFOGRAPHIC_DESIGN_PROMPT,
} from '../src/lib/infographicPrompt.ts';
import { parseDesignResponse, sanitizeInfographicHtml } from '../src/lib/infographicSanitize.ts';
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

// ---------- design: well-formed reply ----------

console.log('\ndesign — strips a <script> tag and an inline event handler');
const dirtyHtml =
  '<!DOCTYPE html><html><head><style>body{color:red}</style><script>alert(1)</script></head>' +
  '<body onclick="alert(2)"><h1>Title</h1></body></html>';
const cleaned = parseDesignResponse(dirtyHtml);
check('no <script survives', cleaned.includes('<script'), false);
check('no onclick= attribute survives', cleaned.toLowerCase().includes('onclick='), false);
check('the real content survives', cleaned.includes('<h1>Title</h1>'), true);
check('the doctype is preserved for standards-mode rendering', cleaned.toLowerCase().startsWith('<!doctype html'), true);

console.log('\ndesign — strips a markdown fence and surrounding prose');
const fencedHtml = 'Here you go:\n```html\n' + dirtyHtml + '\n```\nHope that helps!';
check('extracts and cleans the same document', parseDesignResponse(fencedHtml), cleaned);

console.log('\ndesign — strips an embedded iframe');
const withIframe = '<!DOCTYPE html><html><body><iframe src="https://example.com"></iframe><p>Content</p></body></html>';
const cleanedIframe = parseDesignResponse(withIframe);
check('no <iframe survives', cleanedIframe.includes('<iframe'), false);
check('surrounding content survives', cleanedIframe.includes('<p>Content</p>'), true);

console.log('\ndesign — neutralizes a javascript: URI');
const withJsUri = '<!DOCTYPE html><html><body><a href="javascript:alert(1)">Click</a></body></html>';
check('javascript: is gone from the link', parseDesignResponse(withJsUri).toLowerCase().includes('javascript:'), false);

console.log('\ndesign — whitespace inside the scheme does not smuggle javascript:');
const tabbedScheme = '<!DOCTYPE html><html><body><a href="java&#9;script:alert(1)">c</a></body></html>';
const cleanedTabbed = parseDesignResponse(tabbedScheme).replace(/[\x00-\x20]/g, '');
check('the href does not survive as a javascript: URI', cleanedTabbed.toLowerCase().includes('javascript:'), false);

console.log('\ndesign — strips a meta-refresh and a base tag');
const withMetaBase =
  '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=https://evil.example">' +
  '<base href="https://evil.example/"></head><body><p>Content</p></body></html>';
const cleanedMetaBase = parseDesignResponse(withMetaBase);
check('meta-refresh is gone', cleanedMetaBase.toLowerCase().includes('refresh'), false);
check('base tag is gone', cleanedMetaBase.toLowerCase().includes('<base'), false);
check('surrounding content survives', cleanedMetaBase.includes('<p>Content</p>'), true);

console.log('\ndesign — meta-refresh removal is case-insensitive');
const upperRefresh =
  '<!DOCTYPE html><html><head><meta http-equiv="REFRESH" content="0;url=https://evil.example"></head>' +
  '<body><p>Content</p></body></html>';
check('an uppercase http-equiv is still removed', parseDesignResponse(upperRefresh).toLowerCase().includes('refresh'), false);

console.log('\ndesign — a doctype-less document gets one prepended');
check(
  'quirks-mode rendering is prevented',
  sanitizeInfographicHtml('<html><body><p>x</p></body></html>').toLowerCase().startsWith('<!doctype html'),
  true
);

console.log('\ndesign — no <html> tag at all returns null');
check('pure prose with no document returns null', parseDesignResponse('I cannot generate that.'), null);

console.log('\ndesign — sanitizing clean input does not remove any real content');
const alreadyClean = '<!DOCTYPE html><html><body><h1>Fine</h1></body></html>';
const sanitizedClean = sanitizeInfographicHtml(alreadyClean);
check('the content survives', sanitizedClean.includes('<h1>Fine</h1>'), true);
check('the doctype is preserved', sanitizedClean.toLowerCase().startsWith('<!doctype html'), true);

console.log('\ndesign prompt exists and names every color token');
check('mentions --bg', INFOGRAPHIC_DESIGN_PROMPT.includes('--bg'), true);
check('mentions --accent', INFOGRAPHIC_DESIGN_PROMPT.includes('--accent'), true);
check('mentions data-theme', INFOGRAPHIC_DESIGN_PROMPT.includes('data-theme'), true);
check('asks for an SVG <title> for screen readers', INFOGRAPHIC_DESIGN_PROMPT.toLowerCase().includes('<title>'), true);
check('asks for a matching lang attribute', INFOGRAPHIC_DESIGN_PROMPT.includes('lang='), true);

// ---------- deleteInfographicModalCopy ----------

console.log('\ndeleteInfographicModalCopy');
check(
  'names the infographic in the title',
  deleteInfographicModalCopy('Why Your Reviews Get Farther Apart').title,
  'Delete "Why Your Reviews Get Farther Apart"?'
);
check("the body always warns it can't be undone", deleteInfographicModalCopy('Anything').body, "This can't be undone.");

console.log('\ndesign — a script inside a <template> does not survive');
const templatedScript = '<!DOCTYPE html><html><body><template><script>alert(1)</script></template><p>Keep</p></body></html>';
const cleanedTemplate = parseDesignResponse(templatedScript);
check('no <script survives', cleanedTemplate.toLowerCase().includes('<script'), false);
check('no <template survives', cleanedTemplate.toLowerCase().includes('<template'), false);
check('sibling content survives', cleanedTemplate.includes('<p>Keep</p>'), true);

console.log('\ndesign — javascript: is stripped from action and formaction');
const formVectors = '<!DOCTYPE html><html><body><form action="javascript:alert(1)"><button formaction="javascript:alert(2)">x</button></form></body></html>';
const cleanedForm = parseDesignResponse(formVectors);
check('neither attribute keeps a javascript: URI', cleanedForm.toLowerCase().includes('javascript:'), false);
check('the elements themselves survive', cleanedForm.includes('<form') && cleanedForm.includes('<button'), true);

console.log('\ncomparisons are validated and clamped to 6');
const manyComparisons = JSON.stringify({
  title: 'Comparisons',
  items: [{ label: 'A', detail: 'A detail.' }],
  comparisons: [
    ...Array.from({ length: 7 }, (_, i) => ({ name: `Name ${i + 1}`, value: `Value ${i + 1}` })),
    { name: 'No value' },
  ],
  keyTakeaway: 'Seven valid, one malformed.',
});
const clampedComparisons = parseExtractionResponse(manyComparisons, 'Comparisons', 'detailed');
check('keeps exactly 6 comparisons', clampedComparisons.comparisons.length, 6);
check('keeps the first 6, dropping from the tail', clampedComparisons.comparisons[5].name, 'Name 6');
check('drops a comparison missing its value', JSON.stringify(clampedComparisons.comparisons).includes('No value'), false);

console.log('\ncomparisons is omitted entirely when none survive');
const noValidComparisons = JSON.stringify({
  title: 'None',
  items: [{ label: 'A', detail: 'A detail.' }],
  comparisons: [{ name: 'Only a name' }],
  keyTakeaway: 'Nothing usable.',
});
check(
  'the field is absent rather than an empty array',
  'comparisons' in parseExtractionResponse(noValidComparisons, 'None', 'detailed'),
  false
);

import { MAX_TOKENS as CLIENT_TOKENS, requestTimeoutMs } from '../src/lib/aiTransport.ts';
import { MAX_TOKENS as SERVER_TOKENS } from '../src/server/generateHandler.ts';

console.log('\nMAX_TOKENS stays in step between client and server');
for (const key of ['infographic-extract-basic', 'infographic-extract-standard', 'infographic-extract-detailed', 'infographic-design']) {
  check(`${key} matches`, CLIENT_TOKENS[key], SERVER_TOKENS[key]);
}

import fs from 'node:fs';

console.log('\ndesign prompt color tokens match src/index.css');
const css = fs.readFileSync('src/index.css', 'utf8');
const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('\n}\n', css.indexOf(':root {')));
const darkBlock = css.slice(
  css.indexOf(':root[data-theme="dark"]'),
  css.indexOf('\n}\n', css.indexOf(':root[data-theme="dark"]'))
);

// Only the tokens the design prompt actually mirrors — --shadow-*, --scrim,
// --font-ui, etc. are this app's own UI chrome and were never meant to be
// copied into the infographic's palette (see Task 3's prompt text).
const MIRRORED_TOKENS = [
  'bg', 'surface', 'surface-raised', 'border-soft', 'border-strong',
  'text-primary', 'text-secondary', 'text-faint',
  'accent', 'accent-soft', 'accent-contrast',
  'success', 'success-soft', 'warning', 'warning-soft', 'danger', 'danger-soft',
];

function tokenValue(block, name) {
  const match = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  return match ? match[1].replace(/\s+/g, '') : null;
}

const promptNoSpace = INFOGRAPHIC_DESIGN_PROMPT.replace(/\s+/g, '');
for (const name of MIRRORED_TOKENS) {
  const lightValue = tokenValue(rootBlock, name);
  const darkValue = tokenValue(darkBlock, name);
  check(`--${name} (light) exists in index.css`, lightValue !== null, true);
  check(`--${name} (dark) exists in index.css`, darkValue !== null, true);
  check(`--${name} (light) value is in the design prompt`, lightValue !== null && promptNoSpace.includes(lightValue), true);
  check(`--${name} (dark) value is in the design prompt`, darkValue !== null && promptNoSpace.includes(darkValue), true);
}

// ---------- clamps are runaway protection, not routine editing ----------

// A generated infographic came back with every table cell cut mid-word at
// exactly 60 characters ("...via address calculati…"). That was not CSS in the
// model's HTML — it was this parser's own clamp on a comparison's `value`,
// which sat at 60 while the model naturally writes 50-60 characters for that
// field. The text was destroyed at extraction time, before the design call
// ever saw it, so nothing downstream could have offered to expand it.
console.log('\ncomparison values survive at the length models actually write');
const realisticValue = 'Contiguous memory; O(1) indexed access via address calculation, but O(n) insertion in the middle because every later element shifts';
const realisticComparison = JSON.stringify({
  title: 'Data Structures',
  items: [{ label: 'Array', detail: 'A contiguous block of memory.' }],
  comparisons: [{ name: 'Array', value: realisticValue }],
  keyTakeaway: 'Pick the structure that matches the access pattern.',
});
const keptComparison = parseExtractionResponse(realisticComparison, 'Data Structures', 'standard');
check(
  'a 130-character comparison value is kept whole',
  keptComparison.comparisons[0].value,
  realisticValue
);
check('no ellipsis was introduced', keptComparison.comparisons[0].value.includes('…'), false);

console.log('\nwhen a clamp does fire it cuts at a word boundary');
// Built rather than written out, so it is unambiguously past any budget and
// every cut point falls on a space.
const overLong = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
const clampedTail = parseExtractionResponse(
  JSON.stringify({
    title: 'T',
    items: [{ label: 'A', detail: 'A detail.' }],
    comparisons: [{ name: 'N', value: overLong }],
    keyTakeaway: 'K',
  }),
  'T',
  'standard'
).comparisons[0].value;
check('it ends with an ellipsis', clampedTail.endsWith('…'), true);
check(
  'the character before the ellipsis is not mid-word',
  // The clamped text, ellipsis removed, must be a prefix of the original that
  // ends where a word ends — never "calculati".
  overLong.startsWith(clampedTail.slice(0, -1)) && !/\S$/.test(overLong.charAt(clampedTail.length - 1)),
  true
);

// ---------- request timeout vs. the token ceiling it has to cover ----------

// A real generation failed with "The drafting request timed out after 120
// seconds." Measured against a 24-card deck, the design call returns
// 7,600-11,100 output tokens in 65-95s — a steady ~120 tokens/second — so its
// 16,000-token ceiling implies ~133s of generation. The single global 120s
// timeout was therefore shorter than the response its own ceiling permits, and
// a perfectly good page was aborted as a failure.
//
// 70 tok/s below is a deliberately conservative floor for a slower connection
// than the one measured. This invariant is asserted only for the design task
// on purpose: `cards`, `vignette` and `ocr` share the 16,000 ceiling but send
// batches that never approach it (the ceiling is headroom, not a target), so
// forcing the same rule on them would inflate their timeouts for no reason.
console.log('\nrequest timeout covers the response the token ceiling permits');
const SLOW_TOKENS_PER_SECOND = 70;
const impliedDesignMs = (CLIENT_TOKENS['infographic-design'] / SLOW_TOKENS_PER_SECOND) * 1000;
check(
  'the design call may run at least as long as its ceiling implies',
  requestTimeoutMs('infographic-design') >= impliedDesignMs,
  true
);
check(
  'the extraction calls keep the default timeout',
  requestTimeoutMs('infographic-extract-detailed'),
  requestTimeoutMs('cards')
);

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
