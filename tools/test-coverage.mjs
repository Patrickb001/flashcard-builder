import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateQuestionsForCards } from '../src/lib/quizGenerator.ts';

/**
 * Measures what fraction of a deck gets a question in ONE pass.
 *
 * This is the success criterion for the test-coverage fix, and the one check
 * here whose expected value had to change rather than stay fixed: the prompt
 * used to be skip-biased and the batch sat above the token ceiling, so a run
 * covered roughly half a deck and had to be repeated to fill one.
 *
 *   node --experimental-strip-types --experimental-loader ./tools/ts-ext-hooks.mjs \
 *     tools/test-coverage.mjs
 *
 * It calls the real model over the six golden decks, so it costs money and is
 * not part of the per-phase suite. Run it when the prompt, the batch size or
 * the token ceiling changes.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.join(HERE, 'fixtures', 'golden');

function readKeyFromEnvFile() {
  try {
    return fs.readFileSync(path.join(HERE, '..', '.env'), 'utf8').match(/ANTHROPIC_API_KEY=(.+)/)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

const key = process.env.ANTHROPIC_API_KEY ?? readKeyFromEnvFile();
if (!key) {
  console.log('COVERAGE skipped — set ANTHROPIC_API_KEY to run it.');
  process.exit(0);
}
const settings = { mode: 'byok', apiKey: key };

/** The recorded rule-based cards, as the deck the app would have saved. */
function deckFrom(name) {
  const golden = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, name + '.json'), 'utf8'));
  return golden.cards.map((card, i) => ({
    id: name + '-' + i,
    deckId: name,
    front: card.front,
    back: card.back,
    sourceLabel: card.sourceLabel,
    context: card.context,
    frontCode: card.frontCode,
    backCode: card.backCode,
    image: card.image,
    status: 'active',
    createdAt: 0,
  }));
}

const DECKS = [
  'class-and-object',
  'conditional-statements',
  'for-loop',
  'functions',
  'input-and-output',
  'while-loop',
];

let totalCards = 0;
let totalAnswered = 0;
let anyTruncated = 0;
let failures = 0;

console.log('Generating over six decks in a single pass each.\n');
for (const name of DECKS) {
  const deck = deckFrom(name);
  const result = await generateQuestionsForCards(deck, deck, name, settings);

  const answered = new Set(result.questions.map((q) => q.cardId)).size;
  const pct = Math.round((answered / deck.length) * 100);
  totalCards += deck.length;
  totalAnswered += answered;
  anyTruncated += result.truncatedBatches;

  const flags = [];
  if (result.truncatedBatches > 0) flags.push(result.truncatedBatches + ' truncated');
  if (result.failedBatches > 0) flags.push(result.failedBatches + ' failed');
  if (pct < 100) { flags.push('UNDER 100%'); failures++; }

  console.log(
    '  ' + name.padEnd(24) + String(answered).padStart(3) + '/' + String(deck.length).padEnd(4) +
    String(pct).padStart(4) + '%   ' + result.totalBatches + ' batches' +
    (flags.length ? '   [' + flags.join(', ') + ']' : '')
  );
}

const overall = Math.round((totalAnswered / totalCards) * 100);
console.log('\n  overall'.padEnd(26) + String(totalAnswered).padStart(3) + '/' + String(totalCards).padEnd(4) + String(overall).padStart(4) + '%');
console.log('  batches stopped at the token ceiling: ' + anyTruncated);

if (anyTruncated > 0) { console.log('\nFAIL: a reply was cut off by max_tokens.'); process.exit(1); }
if (failures > 0) { console.log('\nFAIL: ' + failures + ' deck(s) under 100% coverage.'); process.exit(1); }
console.log('\nEvery card in every deck got a question in one pass.');
