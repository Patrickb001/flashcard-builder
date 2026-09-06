import fs from 'node:fs';
import { generateCandidatesWithAi } from '../src/lib/aiGenerator.ts';

/**
 * Exercises the ATOMIC splitting rule (cardPrompt.ts, rule 1) against three
 * synthetic sections built to sit exactly on its three branches — a compound
 * sentence carrying two distinct figures, a small parallel set with no
 * per-item detail, and a long parallel set with no per-item detail.
 *
 * Whether a split reads well is not something an assertion can decide, so
 * results are printed for reading, the same way tools/test-quiz.mjs and
 * tools/test-vignette.mjs read their real-model output. Only the structural
 * counts below are asserted.
 *
 *   node --experimental-strip-types --import ./tools/register.mjs \
 *     tools/test-card-splitting.mjs
 *
 * Calls the model, so it costs real money and only runs with a key present.
 */

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

const sections = [
  {
    label: 'Section 1',
    group: 'splitting-fixture',
    blocks: [
      { kind: 'heading', text: 'Attachment styles and prevalence', level: 1 },
      {
        kind: 'paragraph',
        text: 'Avoidant attachment appears in about 25% of the population; anxious attachment appears in about 10%.',
      },
    ],
  },
  {
    label: 'Section 2',
    group: 'splitting-fixture',
    blocks: [
      { kind: 'heading', text: 'The four attachment styles', level: 1 },
      {
        kind: 'paragraph',
        text: 'The four attachment styles are secure, avoidant, anxious, and disorganized.',
      },
    ],
  },
  {
    label: 'Section 3',
    group: 'splitting-fixture',
    blocks: [
      { kind: 'heading', text: 'Common causes of insomnia', level: 1 },
      {
        kind: 'list',
        items: [
          'Caffeine use',
          'Alcohol use',
          'Shift work',
          'Chronic pain',
          'Anxiety',
          'Depression',
          'Hyperthyroidism',
          'Restless legs syndrome',
          'Sleep apnea',
        ],
      },
    ],
  },
];

console.log(`Drafting ${sections.length} synthetic sections\n`);

const result = await generateCandidatesWithAi(sections, { mode: 'byok', apiKey: key });

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`);
};

const byLabel = (label) => result.cards.filter((c) => c.sourceLabel === label);

for (const section of sections) {
  const cards = byLabel(section.label);
  console.log(`\n${section.label} — ${cards.length} card(s)`);
  for (const card of cards) {
    console.log(`  Q: ${card.front}`);
    console.log(`  A: ${card.back}`);
  }
}

console.log('\nASSERTIONS');
check(
  'the two-figure sentence split into two or more cards',
  byLabel('Section 1').length >= 2,
  `got ${byLabel('Section 1').length}`
);
check(
  'the plain four-item list stayed on a small number of cards',
  byLabel('Section 2').length > 0 && byLabel('Section 2').length <= 2,
  `got ${byLabel('Section 2').length}`
);
check(
  'the nine-item list did not land on a single card',
  byLabel('Section 3').length >= 2,
  `got ${byLabel('Section 3').length} card(s) for 9 items`
);
if (result.firstError) console.log(`\n  !! ${result.firstError}`);

console.log(
  '\n  Read the cards above: Section 1 should show each figure on its own card,\n' +
    '  Section 2 should read as one card naming all four styles, and Section 3\n' +
    '  should be split into smaller groupings rather than one long list-back card.'
);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
