import { parseInfographicResponse } from '../src/lib/infographicPrompt.ts';

/**
 * The infographic response parser: JSON-object extraction and per-level clamping.
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

const basicReply = JSON.stringify({
  title: 'Cell Biology',
  sections: [
    { heading: 'Organelles', icon: 'book', points: ['Mitochondria make ATP.', 'The Golgi packages proteins.'] },
    { heading: 'Membranes', icon: 'arrows', points: ['Osmosis moves water toward solute.'] },
  ],
});

console.log('well-formed reply');
check(
  'parses title and sections through unchanged (within the basic ceiling)',
  parseInfographicResponse(basicReply, 'Cell Biology', 'basic'),
  {
    title: 'Cell Biology',
    sections: [
      { heading: 'Organelles', icon: 'book', points: ['Mitochondria make ATP.', 'The Golgi packages proteins.'] },
      { heading: 'Membranes', icon: 'arrows', points: ['Osmosis moves water toward solute.'] },
    ],
  }
);

console.log('\nfenced reply');
check(
  'strips a markdown fence around the object',
  parseInfographicResponse('```json\n' + basicReply + '\n```', 'Cell Biology', 'basic'),
  { title: 'Cell Biology', sections: JSON.parse(basicReply).sections }
);

console.log('\nclamping — sections beyond the ceiling');
const tooManySections = JSON.stringify({
  title: 'Big Deck',
  sections: Array.from({ length: 10 }, (_, i) => ({
    heading: `Section ${i + 1}`,
    icon: 'list',
    points: ['One point.'],
  })),
});
{
  const result = parseInfographicResponse(tooManySections, 'Big Deck', 'basic');
  check('basic (ceiling 5) keeps only the first 5 of 10 sections', result.sections.length, 5);
  check('kept sections are the first ones, in order', result.sections[0].heading, 'Section 1');
}
{
  const result = parseInfographicResponse(tooManySections, 'Big Deck', 'standard');
  check('standard (ceiling 8) keeps only the first 8 of 10 sections', result.sections.length, 8);
}
{
  const result = parseInfographicResponse(tooManySections, 'Big Deck', 'detailed');
  check('detailed (ceiling 14) keeps all 10 sections unclamped', result.sections.length, 10);
}

console.log('\nclamping — points beyond a section\'s ceiling');
const tooManyPoints = JSON.stringify({
  title: 'Verbose Deck',
  sections: [
    { heading: 'One Section', icon: 'chart', points: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] },
  ],
});
{
  const result = parseInfographicResponse(tooManyPoints, 'Verbose Deck', 'basic');
  check('basic (ceiling 4 points) keeps only the first 4 of 7', result.sections[0].points, ['p1', 'p2', 'p3', 'p4']);
}
{
  const result = parseInfographicResponse(tooManyPoints, 'Verbose Deck', 'standard');
  check('standard (ceiling 5 points) keeps only the first 5 of 7', result.sections[0].points, ['p1', 'p2', 'p3', 'p4', 'p5']);
}
{
  const result = parseInfographicResponse(tooManyPoints, 'Verbose Deck', 'detailed');
  check('detailed (ceiling 6 points) keeps 6 of 7', result.sections[0].points, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
}

console.log('\nempty points are dropped, and a section left with none is dropped too');
const emptyPoints = JSON.stringify({
  title: 'Deck',
  sections: [
    { heading: 'Has real points', icon: 'book', points: ['  ', 'A real point.', ''] },
    { heading: 'All blank', icon: 'list', points: ['', '   '] },
  ],
});
{
  const result = parseInfographicResponse(emptyPoints, 'Deck', 'standard');
  check('blank points are dropped, real ones kept', result.sections.length, 1);
  check('the surviving section is the one with a real point', result.sections[0].heading, 'Has real points');
  check('its points array has only the real point', result.sections[0].points, ['A real point.']);
}

const allSectionsBlank = JSON.stringify({
  title: 'Deck',
  sections: [{ heading: '   ', icon: 'book', points: ['A point.'] }],
});
check(
  'a whitespace-only heading drops the section, and with nothing left the whole response is null',
  parseInfographicResponse(allSectionsBlank, 'Deck', 'standard'),
  null
);

console.log('\nfallbacks');
const badIcon = JSON.stringify({
  title: 'Deck',
  sections: [{ heading: 'H', icon: 'rocketship', points: ['p'] }],
});
check(
  'an icon outside the enum falls back to list',
  parseInfographicResponse(badIcon, 'Deck', 'standard').sections[0].icon,
  'list'
);

const noTitle = JSON.stringify({ title: '', sections: [{ heading: 'H', icon: 'book', points: ['p'] }] });
check(
  'an empty title falls back to the deck name',
  parseInfographicResponse(noTitle, 'Fallback Deck Name', 'standard').title,
  'Fallback Deck Name'
);

console.log('\nunusable replies');
check('prose with no JSON object returns null', parseInfographicResponse('Sorry, I cannot do that.', 'Deck', 'standard'), null);
check('an object with zero sections returns null', parseInfographicResponse(JSON.stringify({ title: 'T', sections: [] }), 'Deck', 'standard'), null);
check('an array instead of an object returns null', parseInfographicResponse('[1,2,3]', 'Deck', 'standard'), null);

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
