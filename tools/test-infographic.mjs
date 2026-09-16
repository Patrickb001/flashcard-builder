import { parseInfographicResponse, INFOGRAPHIC_SYSTEM_PROMPTS } from '../src/lib/infographicPrompt.ts';

/**
 * The infographic response parser: JSON-object extraction and per-block clamping.
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

// ---------- bullets ----------

console.log('bullets — well-formed reply');
const basicReply = JSON.stringify({
  title: 'Cell Biology',
  blocks: [
    { type: 'bullets', heading: 'Organelles', icon: 'book', points: ['Mitochondria make ATP.', 'The Golgi packages proteins.'] },
    { type: 'bullets', heading: 'Membranes', icon: 'arrows', points: ['Osmosis moves water toward solute.'] },
  ],
});
check(
  'parses title and blocks through unchanged (within the basic ceiling)',
  parseInfographicResponse(basicReply, 'Cell Biology', 'basic'),
  {
    title: 'Cell Biology',
    blocks: [
      { type: 'bullets', icon: 'book', heading: 'Organelles', points: ['Mitochondria make ATP.', 'The Golgi packages proteins.'] },
      { type: 'bullets', icon: 'arrows', heading: 'Membranes', points: ['Osmosis moves water toward solute.'] },
    ],
  }
);

console.log('\nfenced reply');
check(
  'strips a markdown fence around the object',
  parseInfographicResponse('```json\n' + basicReply + '\n```', 'Cell Biology', 'basic'),
  {
    title: 'Cell Biology',
    blocks: [
      { type: 'bullets', icon: 'book', heading: 'Organelles', points: ['Mitochondria make ATP.', 'The Golgi packages proteins.'] },
      { type: 'bullets', icon: 'arrows', heading: 'Membranes', points: ['Osmosis moves water toward solute.'] },
    ],
  }
);

console.log('\nbullets — clamping points beyond the level ceiling');
const tooManyPoints = JSON.stringify({
  title: 'Verbose Deck',
  blocks: [{ type: 'bullets', heading: 'One Section', icon: 'chart', points: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] }],
});
{
  const result = parseInfographicResponse(tooManyPoints, 'Verbose Deck', 'basic');
  check('basic (ceiling 4 points) keeps only the first 4 of 7', result.blocks[0].points, ['p1', 'p2', 'p3', 'p4']);
}
{
  const result = parseInfographicResponse(tooManyPoints, 'Verbose Deck', 'standard');
  check('standard (ceiling 5 points) keeps only the first 5 of 7', result.blocks[0].points, ['p1', 'p2', 'p3', 'p4', 'p5']);
}
{
  const result = parseInfographicResponse(tooManyPoints, 'Verbose Deck', 'detailed');
  check('detailed (ceiling 6 points) keeps 6 of 7', result.blocks[0].points, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
}

console.log('\nbullets — empty points are dropped, and a block left with none is dropped too');
const emptyPoints = JSON.stringify({
  title: 'Deck',
  blocks: [
    { type: 'bullets', heading: 'Has real points', icon: 'book', points: ['  ', 'A real point.', ''] },
    { type: 'bullets', heading: 'All blank', icon: 'list', points: ['', '   '] },
  ],
});
{
  const result = parseInfographicResponse(emptyPoints, 'Deck', 'standard');
  check('blank points are dropped, real ones kept', result.blocks.length, 1);
  check('the surviving block is the one with a real point', result.blocks[0].heading, 'Has real points');
  check('its points array has only the real point', result.blocks[0].points, ['A real point.']);
}

const blankHeading = JSON.stringify({
  title: 'Deck',
  blocks: [{ type: 'bullets', heading: '   ', icon: 'book', points: ['A point.'] }],
});
check(
  'a whitespace-only heading drops the block, and with nothing left the whole response is null',
  parseInfographicResponse(blankHeading, 'Deck', 'standard'),
  null
);

console.log('\nbullets — icon fallback');
const badIcon = JSON.stringify({
  title: 'Deck',
  blocks: [{ type: 'bullets', heading: 'H', icon: 'rocketship', points: ['p'] }],
});
check(
  'an icon outside the enum falls back to list',
  parseInfographicResponse(badIcon, 'Deck', 'standard').blocks[0].icon,
  'list'
);

// ---------- callout ----------

console.log('\ncallout');
check(
  'a well-formed callout keeps its tone and text',
  parseInfographicResponse(
    JSON.stringify({ title: 'Deck', blocks: [{ type: 'callout', tone: 'info', text: 'Careful here.' }] }),
    'Deck',
    'standard'
  ).blocks[0],
  { type: 'callout', tone: 'info', text: 'Careful here.' }
);
check(
  'an unrecognized tone falls back to warning',
  parseInfographicResponse(
    JSON.stringify({ title: 'Deck', blocks: [{ type: 'callout', tone: 'scary', text: 'Careful here.' }] }),
    'Deck',
    'standard'
  ).blocks[0].tone,
  'warning'
);
{
  const longText = 'x'.repeat(250);
  const result = parseInfographicResponse(
    JSON.stringify({ title: 'Deck', blocks: [{ type: 'callout', tone: 'warning', text: longText }] }),
    'Deck',
    'standard'
  );
  check('callout text over 220 chars is clamped with a trailing ellipsis', result.blocks[0].text.length, 221);
  check('the clamped text ends with an ellipsis', result.blocks[0].text.endsWith('…'), true);
}
check(
  'a callout with no text is dropped',
  parseInfographicResponse(JSON.stringify({ title: 'Deck', blocks: [{ type: 'callout', tone: 'warning', text: '' }] }), 'Deck', 'standard'),
  null
);

// ---------- stat ----------

console.log('\nstat');
check(
  'a well-formed stat keeps its value, unit, and caption',
  parseInfographicResponse(
    JSON.stringify({ title: 'Deck', blocks: [{ type: 'stat', heading: 'Longest interval', value: '62', unit: 'days', caption: 'After four Good reviews.' }] }),
    'Deck',
    'standard'
  ).blocks[0],
  { type: 'stat', heading: 'Longest interval', value: '62', unit: 'days', caption: 'After four Good reviews.' }
);
check(
  'a missing unit key is omitted entirely, not present as undefined',
  'unit' in parseInfographicResponse(
    JSON.stringify({ title: 'Deck', blocks: [{ type: 'stat', heading: 'H', value: '1', caption: 'c' }] }),
    'Deck',
    'standard'
  ).blocks[0],
  false
);
{
  const result = parseInfographicResponse(
    JSON.stringify({ title: 'Deck', blocks: [{ type: 'stat', heading: 'H', value: '123456789012345', caption: 'c' }] }),
    'Deck',
    'standard'
  );
  check('a value over 12 chars is clamped with a trailing ellipsis', result.blocks[0].value.length, 13);
}
check(
  'a stat with no value is dropped',
  parseInfographicResponse(JSON.stringify({ title: 'Deck', blocks: [{ type: 'stat', heading: 'H', value: '', caption: 'c' }] }), 'Deck', 'standard'),
  null
);

// ---------- quote ----------

console.log('\nquote');
check(
  'a well-formed quote is kept as-is — no fidelity check against any source card',
  parseInfographicResponse(
    JSON.stringify({ title: 'Deck', blocks: [{ type: 'quote', text: "Mitochondria are the cell's power plants." }] }),
    'Deck',
    'standard'
  ).blocks[0],
  { type: 'quote', text: "Mitochondria are the cell's power plants." }
);
{
  const longQuote = 'x'.repeat(250);
  const result = parseInfographicResponse(JSON.stringify({ title: 'Deck', blocks: [{ type: 'quote', text: longQuote }] }), 'Deck', 'standard');
  check('quote text over 200 chars is clamped with a trailing ellipsis', result.blocks[0].text.length, 201);
}
check(
  'a quote with no text is dropped',
  parseInfographicResponse(JSON.stringify({ title: 'Deck', blocks: [{ type: 'quote', text: '   ' }] }), 'Deck', 'standard'),
  null
);

// ---------- unrecognized block types ----------

console.log('\nunrecognized block type');
check(
  "a block whose type isn't recognized is dropped without affecting siblings",
  parseInfographicResponse(
    JSON.stringify({
      title: 'Deck',
      blocks: [
        { type: 'made-up-type', heading: 'Mystery', points: ['p'] },
        { type: 'bullets', heading: 'Real one', icon: 'book', points: ['p'] },
      ],
    }),
    'Deck',
    'standard'
  ).blocks,
  [{ type: 'bullets', icon: 'book', heading: 'Real one', points: ['p'] }]
);

// ---------- total block count + dense-type ceilings ----------

// ---------- timeline ----------

console.log('\ntimeline');
check(
  'a well-formed timeline keeps its steps and caption',
  parseInfographicResponse(
    JSON.stringify({ title: 'Deck', blocks: [{ type: 'timeline', heading: 'Growth', icon: 'chart', steps: [{ label: '1d' }, { label: '3d' }], caption: 'Grows each time.' }] }),
    'Deck',
    'standard'
  ).blocks[0],
  { type: 'timeline', icon: 'chart', heading: 'Growth', steps: [{ label: '1d' }, { label: '3d' }], caption: 'Grows each time.' }
);
{
  const manySteps = Array.from({ length: 9 }, (_, i) => ({ label: `s${i}` }));
  const result = parseInfographicResponse(
    JSON.stringify({ title: 'Deck', blocks: [{ type: 'timeline', heading: 'H', icon: 'clock', steps: manySteps, caption: 'c' }] }),
    'Deck',
    'detailed'
  );
  check('timeline steps are clamped to 6 regardless of level', result.blocks[0].steps.length, 6);
}
check(
  'an icon outside the enum falls back to clock',
  parseInfographicResponse(
    JSON.stringify({ title: 'Deck', blocks: [{ type: 'timeline', heading: 'H', icon: 'nope', steps: [{ label: 's' }], caption: 'c' }] }),
    'Deck',
    'standard'
  ).blocks[0].icon,
  'clock'
);
check(
  'a timeline with zero usable steps is dropped',
  parseInfographicResponse(JSON.stringify({ title: 'Deck', blocks: [{ type: 'timeline', heading: 'H', icon: 'clock', steps: [], caption: 'c' }] }), 'Deck', 'standard'),
  null
);

// ---------- table ----------

console.log('\ntable');
check(
  'a well-formed table keeps its columns and rows',
  parseInfographicResponse(
    JSON.stringify({ title: 'Deck', blocks: [{ type: 'table', heading: 'Grades', columns: ['Grade', 'Ease'], rows: [['Again', '-0.20'], ['Good', '+0.00']] }] }),
    'Deck',
    'standard'
  ).blocks[0],
  { type: 'table', heading: 'Grades', columns: ['Grade', 'Ease'], rows: [['Again', '-0.20'], ['Good', '+0.00']] }
);
{
  const columns = ['a', 'b', 'c', 'd', 'e'];
  const rows = Array.from({ length: 8 }, (_, i) => columns.map((c) => `${c}${i}`));
  const result = parseInfographicResponse(JSON.stringify({ title: 'Deck', blocks: [{ type: 'table', heading: 'H', columns, rows }] }), 'Deck', 'detailed');
  check('columns are clamped to 4', result.blocks[0].columns.length, 4);
  check('rows are clamped to 6', result.blocks[0].rows.length, 6);
  check('each row is clamped to the kept column count', result.blocks[0].rows[0].length, 4);
}
check(
  'a table with no columns is dropped',
  parseInfographicResponse(JSON.stringify({ title: 'Deck', blocks: [{ type: 'table', heading: 'H', columns: [], rows: [['x']] }] }), 'Deck', 'standard'),
  null
);

// ---------- compare ----------

console.log('\ncompare');
check(
  'a well-formed compare keeps both columns',
  parseInfographicResponse(
    JSON.stringify({
      title: 'Deck',
      blocks: [{ type: 'compare', heading: 'Timing', left: { label: 'Too early', points: ['Wastes a review'] }, right: { label: 'Too late', points: ['Already forgotten'] } }],
    }),
    'Deck',
    'standard'
  ).blocks[0],
  { type: 'compare', heading: 'Timing', left: { label: 'Too early', points: ['Wastes a review'] }, right: { label: 'Too late', points: ['Already forgotten'] } }
);
check(
  'a compare missing its right column is dropped',
  parseInfographicResponse(JSON.stringify({ title: 'Deck', blocks: [{ type: 'compare', heading: 'H', left: { label: 'A', points: ['p'] } }] }), 'Deck', 'standard'),
  null
);
{
  const manyPoints = Array.from({ length: 7 }, (_, i) => `p${i}`);
  const result = parseInfographicResponse(
    JSON.stringify({ title: 'Deck', blocks: [{ type: 'compare', heading: 'H', left: { label: 'L', points: manyPoints }, right: { label: 'R', points: ['p'] } }] }),
    'Deck',
    'basic'
  );
  check("a column's points are clamped to the level ceiling (basic: 4)", result.blocks[0].left.points.length, 4);
}

// ---------- steps ----------

console.log('\nsteps');
check(
  'a well-formed steps block keeps its items',
  parseInfographicResponse(
    JSON.stringify({ title: 'Deck', blocks: [{ type: 'steps', heading: 'How grading works', items: ['See the card', 'Rate it'] }] }),
    'Deck',
    'standard'
  ).blocks[0],
  { type: 'steps', heading: 'How grading works', items: ['See the card', 'Rate it'] }
);
{
  const manyItems = Array.from({ length: 9 }, (_, i) => `i${i}`);
  const result = parseInfographicResponse(JSON.stringify({ title: 'Deck', blocks: [{ type: 'steps', heading: 'H', items: manyItems }] }), 'Deck', 'detailed');
  check('items are clamped to the level ceiling (detailed: 6)', result.blocks[0].items.length, 6);
}
check(
  'a steps block with zero usable items is dropped',
  parseInfographicResponse(JSON.stringify({ title: 'Deck', blocks: [{ type: 'steps', heading: 'H', items: ['   ', ''] }] }), 'Deck', 'standard'),
  null
);

console.log('\ntotal block count ceiling');
const manyBullets = (n) =>
  Array.from({ length: n }, (_, i) => ({ type: 'bullets', heading: `H${i}`, icon: 'book', points: ['p'] }));
{
  const result = parseInfographicResponse(JSON.stringify({ title: 'Deck', blocks: manyBullets(5) }), 'Deck', 'basic');
  check('basic (ceiling 3) keeps only the first 3 of 5 blocks', result.blocks.length, 3);
  check('kept blocks are the first ones, in order', result.blocks[0].heading, 'H0');
}
{
  const result = parseInfographicResponse(JSON.stringify({ title: 'Deck', blocks: manyBullets(8) }), 'Deck', 'standard');
  check('standard (ceiling 6) keeps only the first 6 of 8 blocks', result.blocks.length, 6);
}
{
  const result = parseInfographicResponse(JSON.stringify({ title: 'Deck', blocks: manyBullets(12) }), 'Deck', 'detailed');
  check('detailed (ceiling 10) keeps only the first 10 of 12 blocks', result.blocks.length, 10);
}

console.log("\ndense-type combined cap (stat + compare + table)");
{
  const twoStats = [
    { type: 'stat', heading: 'First', value: '1', caption: 'c' },
    { type: 'stat', heading: 'Second', value: '2', caption: 'c' },
    { type: 'bullets', heading: 'Bullets after', icon: 'book', points: ['p'] },
  ];
  const result = parseInfographicResponse(JSON.stringify({ title: 'Deck', blocks: twoStats }), 'Deck', 'detailed');
  check('only the first stat is kept', result.blocks.filter((b) => b.type === 'stat').length, 1);
  check(
    "the second stat is skipped without consuming the bullets block's slot in the total ceiling",
    result.blocks.map((b) => b.heading),
    ['First', 'Bullets after']
  );
}

// ---------- unusable replies ----------

console.log('\nunusable replies');
check('prose with no JSON object returns null', parseInfographicResponse('Sorry, I cannot do that.', 'Deck', 'standard'), null);
check('an object with zero blocks returns null', parseInfographicResponse(JSON.stringify({ title: 'T', blocks: [] }), 'Deck', 'standard'), null);
check('an array instead of an object returns null', parseInfographicResponse('[1,2,3]', 'Deck', 'standard'), null);

const noTitle = JSON.stringify({ title: '', blocks: [{ type: 'bullets', heading: 'H', icon: 'book', points: ['p'] }] });
check(
  'an empty title falls back to the deck name',
  parseInfographicResponse(noTitle, 'Fallback Deck Name', 'standard').title,
  'Fallback Deck Name'
);

// ---------- prompt rubric coverage ----------

console.log('\nprompt rubric coverage');
check('basic prompt mentions bullets', INFOGRAPHIC_SYSTEM_PROMPTS.basic.includes('bullets'), true);
check('basic prompt mentions stat', INFOGRAPHIC_SYSTEM_PROMPTS.basic.includes('stat'), true);
check("basic prompt keeps its rubric short (doesn't spell out every type)", INFOGRAPHIC_SYSTEM_PROMPTS.basic.includes('compare'), false);
for (const type of ['bullets', 'timeline', 'table', 'callout', 'stat', 'compare', 'steps', 'quote']) {
  check(`standard prompt mentions "${type}"`, INFOGRAPHIC_SYSTEM_PROMPTS.standard.includes(type), true);
  check(`detailed prompt mentions "${type}"`, INFOGRAPHIC_SYSTEM_PROMPTS.detailed.includes(type), true);
}
check('every level still names "blocks" as the reply key, not "sections"', INFOGRAPHIC_SYSTEM_PROMPTS.standard.includes('"blocks"'), true);

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
