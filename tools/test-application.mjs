import 'fake-indexeddb/auto';
import fs from 'node:fs';
import {
  APPLICATION_AUDIT_SYSTEM_PROMPT,
  APPLICATION_SYSTEM_PROMPT,
  QUIZ_SYSTEM_PROMPT,
  parseApplicationResponse,
} from '../src/lib/quizPrompt.ts';
import { cardsNeedingQuestions, generateQuestionsForCards, hashCard } from '../src/lib/quizGenerator.ts';
import { MAX_TOKENS as CLIENT_TOKENS } from '../src/lib/aiTransport.ts';
import { MAX_TOKENS as SERVER_TOKENS } from '../src/server/generateHandler.ts';
import { styleOf } from '../src/types.ts';

/**
 * The application-question path.
 *
 *   node --experimental-strip-types --import ./tools/register.mjs tools/test-application.mjs
 *
 * Every section but the last runs with no key and no network. GENERATOR drives
 * the real generator against a stubbed model — fetch is replaced, so no request
 * leaves the machine — which is what checks skips, the audit and the retry pass
 * end to end. DATABASE runs the skip marker against an in-memory IndexedDB.
 *
 * The last section calls the real model, and only when ANTHROPIC_API_KEY is set
 * in the environment: whether a scenario is fair, and whether a traced program
 * really prints what the answer says, is for reading, not asserting. Unlike the
 * older harnesses this one never reads .env, so it cannot spend money by
 * accident.
 */

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`}`
  );
}

const reply = (elements) => JSON.stringify(elements);
const question = (id, extra = {}) => ({
  id,
  scenario: 'A bakery raises its croissant price from $3 to $4 and its costs do not change.',
  stem: 'What does the law of supply predict?',
  correct: 'More croissants are supplied',
  distractors: ['Fewer croissants are supplied', 'The same number is supplied', 'The price falls back to $3'],
  explanation: 'A higher price with unchanged costs raises the quantity supplied.',
  ...extra,
});

// ---------------------------------------------------------------------------
console.log('\nPARSER');
// ---------------------------------------------------------------------------

const one = parseApplicationResponse(reply([question('q1')]));
check('a scenario question parses', one.questions.length, 1);
check('... with three distractors', one.questions[0].distractors.length, 3);
check('... carrying its scenario as the vignette field', one.questions[0].vignette.startsWith('A bakery'), true);
check('... and no program', one.questions[0].code, undefined);

const skip = parseApplicationResponse(reply([{ id: 'q1', skip: 'A name to remember.' }]));
check('a skip is not a question', skip.questions.length, 0);
check('a skip is reported with its reason', skip.skipped, [{ id: 'q1', reason: 'A name to remember.' }]);
check(
  'an empty skip reason is not a skip',
  parseApplicationResponse(reply([{ id: 'q1', skip: '  ' }])).skipped.length,
  0
);
check(
  'a question that also says skip is a question',
  parseApplicationResponse(reply([question('q1', { skip: 'x' })])).questions.length,
  1
);
const twice = parseApplicationResponse(reply([{ id: 'q1', skip: 'x' }, question('q1')]));
check('the first reply for an id wins', [twice.skipped.length, twice.questions.length], [1, 0]);

check(
  'no scenario and no program is recall in disguise, and is dropped',
  parseApplicationResponse(reply([question('q1', { scenario: '' })])).questions.length,
  0
);

const program = "n = 10\nwhile n < 5:\n    print(n)\n    n += 1\nprint('done')";
const withCode = parseApplicationResponse(
  reply([question('q1', { scenario: '', code: { language: 'python', text: program } })])
).questions;
check('a program alone is enough', withCode.length, 1);
check('the program keeps its indentation and line breaks', withCode[0].code?.text, program);
check('... and its language', withCode[0].code?.language, 'python');
check(
  'trailing whitespace is trimmed from a program',
  parseApplicationResponse(reply([question('q1', { code: { text: 'x = 1\n\n  ' } })])).questions[0].code.text,
  'x = 1'
);
check(
  'a program with no text drops the question',
  parseApplicationResponse(reply([question('q1', { code: { language: 'js', text: ' ' } })])).questions.length,
  0
);
check(
  'a program that is not an object drops the question',
  parseApplicationResponse(reply([question('q1', { code: 'print(1)' })])).questions.length,
  0
);
check(
  'a program over 25 lines drops the question',
  parseApplicationResponse(reply([question('q1', { code: { text: 'x\n'.repeat(26) + 'x' } })])).questions.length,
  0
);
check(
  'a program over 1500 characters drops the question',
  parseApplicationResponse(reply([question('q1', { code: { text: 'x'.repeat(1501) } })])).questions.length,
  0
);
check(
  'two distractors is not enough',
  parseApplicationResponse(reply([question('q1', { distractors: ['a', 'b'] })])).questions.length,
  0
);
check(
  'five distractors are trimmed to three',
  parseApplicationResponse(reply([question('q1', { distractors: ['a', 'b', 'c', 'd', 'e'] })])).questions[0].distractors
    .length,
  3
);
const cut = reply([question('q1'), { id: 'q2', skip: 'x' }]).slice(0, -1) + ',{"id":"q3","scenario":"A tra';
const salvaged = parseApplicationResponse(cut);
check('a truncated reply keeps its complete elements', [salvaged.questions.length, salvaged.skipped.length], [1, 1]);

// ---------------------------------------------------------------------------
console.log('\nWHICH CARDS NEED A QUESTION');
// ---------------------------------------------------------------------------

const card = (id, extra = {}) => ({
  id, deckId: 'd1', front: `Front ${id}`, back: `Back ${id}`, sourceLabel: 'Page 1',
  status: 'new', createdAt: 0, ...extra,
});
const c1 = card('c1');
const c2 = card('c2');
const c3 = card('c3', { applicationSkipHash: hashCard(card('c3')) });
const c4 = card('c4', { applicationSkipHash: 'stale-hash' });
const deck = [c1, c2, c3, c4];
const q = (cardId, style, hash) => ({ id: `${cardId}-${style}`, cardId, style, cardHash: hash });
const pool = [q('c1', 'application', hashCard(c1)), q('c2', 'recall', hashCard(c2)), q('c1', 'recall', 'old')];

const app = cardsNeedingQuestions(deck, pool, 'application');
check('application: a card with a current question is not offered', app.unwritten.some((c) => c.id === 'c1'), false);
check('application: a recall question does not count', app.unwritten.some((c) => c.id === 'c2'), true);
check('application: a card skipped at its current text is not offered', app.unwritten.some((c) => c.id === 'c3'), false);
check('... and is reported as skipped', app.skipped.map((c) => c.id), ['c3']);
check('application: an edited card is offered again despite its old skip', app.unwritten.some((c) => c.id === 'c4'), true);
const recall = cardsNeedingQuestions(deck, pool, 'recall');
check('recall: a skip means nothing', recall.skipped.length, 0);
check('recall: a question from changed text is offered again', recall.unwritten.map((c) => c.id), ['c1', 'c3', 'c4']);
check('an application question is its own style', styleOf({ style: 'application' }), 'application');

// ---------------------------------------------------------------------------
console.log('\nTRANSPORT');
// ---------------------------------------------------------------------------

check('the client knows the application task', CLIENT_TOKENS.application, 16000);
check('the client knows its audit', CLIENT_TOKENS['application-audit'], 4000);
check('the server agrees', [SERVER_TOKENS.application, SERVER_TOKENS['application-audit']], [16000, 4000]);

// ---------------------------------------------------------------------------
console.log('\nGENERATOR (stubbed model)');
// ---------------------------------------------------------------------------

const deckCards = [
  card('k1', { front: 'What happens to quantity supplied when price rises?', back: 'It increases.', frontCode: { text: 'OLD EXAMPLE' }, image: { src: 'https://x/y.png' } }),
  card('k2', { front: 'When is a while condition checked?', back: 'Before each iteration.' }),
  card('k3', { front: 'Who proposed general relativity?', back: 'Albert Einstein.' }),
  card('k4', { front: 'What does a for loop repeat?', back: 'A block, a set number of times.' }),
];

/**
 * A pretend Anthropic API. It answers by which system prompt it was sent and
 * which cards are in the batch, and records every call for the checks below.
 *
 *   k1: a scenario question — flagged by the FIRST audit, so it must be retried
 *   k2: a code question
 *   k3: skipped (nothing to apply)
 *   k4: omitted from the first reply entirely, so it must be retried
 */
const calls = [];
let auditRound = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const system = body.system[0].text;
  const payload = JSON.parse(body.messages[0].content)[0];
  const task =
    system === APPLICATION_SYSTEM_PROMPT ? 'application'
    : system === APPLICATION_AUDIT_SYSTEM_PROMPT ? 'application-audit'
    : system === QUIZ_SYSTEM_PROMPT ? 'quiz'
    : 'other';
  calls.push({ task, maxTokens: body.max_tokens, payload });

  let text = '[]';
  if (task === 'application') {
    const retry = calls.filter((c) => c.task === 'application').length > 1;
    text = reply(
      payload.cards.flatMap((c) => {
        if (c.front.startsWith('What happens')) return [question(c.id)];
        if (c.front.startsWith('When is'))
          return [question(c.id, { scenario: '', stem: 'What does this program print?', code: { language: 'python', text: program } })];
        if (c.front.startsWith('Who')) return [{ id: c.id, skip: 'A name to remember.' }];
        return retry ? [question(c.id, { scenario: 'A loop prints a greeting.' })] : [];
      })
    );
  } else if (task === 'application-audit') {
    auditRound += 1;
    text = reply(
      payload.questions.map((item) => ({
        id: item.id,
        ok: !(auditRound === 1 && item.stem.startsWith('What does the law')),
      }))
    );
  } else if (task === 'quiz') {
    text = reply(payload.cards.map((c) => ({ ...question(c.id), scenario: undefined })));
  }
  return { ok: true, json: async () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }), text: async () => '' };
};

const settings = { mode: 'byok', apiKey: 'stub' };
const skippedSeen = [];
const saved = [];
const result = await generateQuestionsForCards(deckCards, deckCards, 'Mixed deck', settings, {
  style: 'application',
  onBatch: async (batch) => saved.push(...batch),
  onSkip: async (cards) => skippedSeen.push(...cards.map((c) => c.id)),
});
const byCard = new Map(result.questions.map((qq) => [qq.cardId, qq]));

check('three cards get questions, including both retried ones', [...byCard.keys()].sort(), ['k1', 'k2', 'k4']);
check('the skipped card is reported, not failed', [result.notApplicableCardIds, result.failedCardIds], [['k3'], []]);
check('onSkip is told about it once', skippedSeen, ['k3']);
check('every question was also handed to onBatch', saved.length, 3);
check('every question is stamped application', result.questions.every((qq) => qq.style === 'application'), true);
check("the card's own snippet is not attached", byCard.get('k1').stemCode, undefined);
check("the card's own diagram is not attached", byCard.get('k1').stemImage, undefined);
check('the new program is attached', byCard.get('k2').stemCode?.text, program);
check('the scenario is stored', byCard.get('k1').vignette?.startsWith('A bakery'), true);
check('the hash matches the source card', byCard.get('k2').cardHash, hashCard(deckCards[1]));
check('generation used the application prompt and ceiling', calls.find((c) => c.task === 'application')?.maxTokens, 16000);
check('every question was audited', calls.filter((c) => c.task === 'application-audit').length >= 2, true);
const firstAudit = calls.find((c) => c.task === 'application-audit').payload.questions;
check('the audit is sent the program to trace', firstAudit.some((item) => item.code === program), true);
check('the audit is sent scenarios as scenarios', firstAudit.every((item) => 'scenario' in item && !('vignette' in item)), true);
const firstAuditContext = calls.find((c) => c.task === 'application-audit').payload.context;
check(
  'the audit sees every card in the batch, even one skipped',
  firstAuditContext.some((c) => c.front.startsWith('Who')),
  true
);
check('a skipped card is never audited', firstAudit.some((item) => item.card?.front.startsWith('Who')), false);
check('the skipped card is not sent again on the retry pass', calls.filter((c) => c.task === 'application').at(-1).payload.cards.some((c) => c.front.startsWith('Who')), false);
// The retry batch leaves the other cards out, so it is the one with neighbours.
const retryPayload = calls.filter((c) => c.task === 'application').at(-1).payload;
check('application neighbours carry both halves', typeof retryPayload.neighbours[0]?.front, 'string');
check('the first audit saw both new questions', firstAudit.length, 2);

calls.length = 0;
const recallRun = await generateQuestionsForCards(deckCards.slice(0, 1), deckCards, 'Mixed deck', settings, {});
check('recall is unchanged: one call, no audit', calls.map((c) => c.task), ['quiz']);
check("recall still carries the card's own snippet", recallRun.questions[0].stemCode?.text, 'OLD EXAMPLE');
check('recall never reports skips', recallRun.notApplicableCardIds, []);

// ---------------------------------------------------------------------------
console.log('\nFIXTURE: render and commit');
// ---------------------------------------------------------------------------

// A real deck (a React slide deck), annotated with the verdict each card
// should get: "apply", "skip", or "either" where both are defensible. Cards
// marked "watch" are known traps; the real-model section below prints them.
const rc = JSON.parse(fs.readFileSync('tools/fixtures/render-and-commit-cards.json', 'utf8'));
const verdicts = { apply: 0, skip: 0, either: 0 };
for (const c of rc) if (c.expect in verdicts) verdicts[c.expect] += 1;
check('the fixture has 24 cards with unique ids', [rc.length, new Set(rc.map((c) => c.id)).size], [24, 24]);
check('every card carries a verdict', verdicts.apply + verdicts.skip + verdicts.either, 24);
check('nine apply, ten skip, five either', verdicts, { apply: 9, skip: 10, either: 5 });
check('the three known traps are annotated', ['c11', 'c17', 'c23'].every((id) => rc.find((c) => c.id === id)?.watch), true);

calls.length = 0;
await generateQuestionsForCards(rc.slice(9, 11), rc, 'Render and commit', settings, { style: 'application' });
const sent = JSON.stringify(calls.map((c) => c.payload));
check('fixture annotations never reach the model', ['"expect"', '"watch"', 'Trap:'].some((t) => sent.includes(t)), false);

// ---------------------------------------------------------------------------
console.log('\nDATABASE (in-memory IndexedDB)');
// ---------------------------------------------------------------------------

const db = await import('../src/db/db.ts');
const now = new Date(2026, 0, 10, 9).getTime();
await db.saveDeckWithCards(
  { id: 'd1', name: 'Deck', sourceFileName: 'x.md', sourceType: 'md', createdAt: 0, cardCount: 2 },
  [card('m1'), card('m2')]
);
await db.reviewCard('m1', 'good', now);
await db.markApplicationSkipped([{ cardId: 'm1', cardHash: hashCard(card('m1')) }, { cardId: 'gone', cardHash: 'x' }]);
let stored = await db.getCardsForDeck('d1');
const m1 = stored.find((c) => c.id === 'm1');
check('a skip is recorded against the hash it was judged on', m1.applicationSkipHash, hashCard(card('m1')));
check("recording a skip leaves the card's schedule alone", m1.srs?.intervalDays, 1);
check('a skip for a deleted card does not recreate it', stored.length, 2);
check('the stored card is now skipped', cardsNeedingQuestions(stored, [], 'application').skipped.map((c) => c.id), ['m1']);
await db.updateCardContent('m1', { front: 'A new front?', back: 'A new back.' });
stored = await db.getCardsForDeck('d1');
check(
  'editing the card offers it for application again',
  cardsNeedingQuestions(stored, [], 'application').unwritten.map((c) => c.id),
  ['m1', 'm2']
);

// ---------------------------------------------------------------------------
// The real model, for reading
// ---------------------------------------------------------------------------

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.log('\nGENERATION skipped — set ANTHROPIC_API_KEY in the environment to run it.');
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

console.log('\nGENERATION (real model)');
globalThis.fetch = realFetch;

const cards = JSON.parse(fs.readFileSync(process.argv[2] ?? 'tools/fixtures/quiz-cards.json', 'utf8'));
const live = await generateQuestionsForCards(cards, cards, 'Loops', { mode: 'byok', apiKey: key }, {
  style: 'application',
});
console.log(
  `  ${live.questions.length} questions, ${live.notApplicableCardIds.length} skipped, ` +
    `${live.failedCardIds.length} failed, of ${cards.length} cards ` +
    `(${live.totalBatches - live.failedBatches}/${live.totalBatches} batches, ${live.truncatedBatches} truncated)\n`
);

const liveCards = new Map(cards.map((c) => [c.id, c]));
for (const item of live.questions) {
  const source = liveCards.get(item.cardId);
  if (item.vignette) console.log(`  ${item.vignette}`);
  if (item.stemCode) console.log(item.stemCode.text.replace(/^/gm, '    | '));
  console.log(`  Q: ${item.stem}`);
  console.log(`     * ${item.correctAnswer}`);
  for (const d of item.distractors) console.log(`       ${d}`);
  console.log(`     why: ${item.explanation}`);
  console.log(`     card: ${source?.front} -> ${source?.back}\n`);
}
for (const id of live.notApplicableCardIds) {
  const source = liveCards.get(id);
  console.log(`  SKIPPED: ${source?.front} -> ${source?.back}`);
}

check('every card is answered, skipped or reported', live.questions.length + live.notApplicableCardIds.length + live.failedCardIds.length, cards.length);
check('every question has three distractors', live.questions.every((item) => item.distractors.length === 3), true);
check('every question has a scenario or a program', live.questions.every((item) => item.vignette || item.stemCode), true);

// Scored against the fixture's verdicts, when it has them. Reported, not
// asserted: one run of a model is a sample, and the numbers belong in
// docs/tuning-notes.md rather than in a pass/fail.
if (cards.some((c) => c.expect)) {
  const asked = new Map(live.questions.map((item) => [item.cardId, item]));
  const skippedIds = new Set(live.notApplicableCardIds);
  const shouldSkip = cards.filter((c) => c.expect === 'skip');
  const shouldApply = cards.filter((c) => c.expect === 'apply');
  const forced = shouldSkip.filter((c) => asked.has(c.id));
  const dodged = shouldApply.filter((c) => skippedIds.has(c.id));
  console.log('\nAGAINST THE FIXTURE');
  console.log(`  skipped as expected: ${shouldSkip.length - forced.length} of ${shouldSkip.length}`);
  for (const c of forced) console.log(`    FORCED  ${c.id}: ${c.front}`);
  console.log(`  applied as expected: ${shouldApply.length - dodged.length} of ${shouldApply.length}`);
  for (const c of dodged) console.log(`    DODGED  ${c.id}: ${c.front}`);
  for (const c of cards.filter((card) => card.watch)) {
    const item = asked.get(c.id);
    console.log(`\n  WATCH ${c.id}: ${c.watch}`);
    console.log(
      item
        ? `    -> ${item.vignette ?? ''} ${item.stemCode ? '[program]' : ''}\n       Q: ${item.stem}\n       * ${item.correctAnswer} | ${item.distractors.join(' | ')}`
        : `    -> ${skippedIds.has(c.id) ? 'skipped' : 'no question (failed)'}`
    );
  }
}

console.log(
  '\n  Read the questions above. For each: is the situation new (not the card\'s own example)?\n' +
    '  Does the answer follow from the card alone? Could any wrong option be defended?\n' +
    '  For a program, run it and confirm the output. For each skip: is there truly nothing to apply?'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
