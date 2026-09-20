import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { sectionsFromDocument } from '../src/lib/htmlParser.ts';
import { generateCandidatesWithAi } from '../src/lib/aiGenerator.ts';
import { CARD_SYSTEM_PROMPT } from '../src/lib/cardPrompt.ts';
import { danglingReference } from '../src/lib/cardValidation.ts';
import { contentWords, overlapRatio } from '../src/lib/textUtils.ts';

/**
 * Drafts one document with the OLD card prompt and the CURRENT one, side by
 * side, and counts the problems each produces.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node --experimental-strip-types --import ./tools/register.mjs \
 *     tools/compare-card-prompts.mjs https://react.dev/learn/render-and-commit \
 *     --runs 2 --compare tools/fixtures/render-and-commit-cards.json
 *
 *   node --experimental-strip-types --import ./tools/register.mjs \
 *     tools/compare-card-prompts.mjs --dry-run
 *
 * Why it exists: comparing a deck drafted weeks ago against one drafted today
 * mixes up two things — the prompt change, and the ordinary difference between
 * one run and the next. This drafts the same page, with the same model, in the
 * same session, several times with each prompt, so a difference that shows up
 * in every run of one prompt and none of the other is the prompt's doing.
 *
 * The old prompt is `tools/fixtures/card-prompt-baseline.txt`: the card prompt
 * as it stood before the card-prompt fixes plan. It is swapped in at the last
 * moment, on the request itself, so both variants run through exactly the same
 * code. Nothing in the app is changed.
 *
 * The source may be a URL or a saved .html file. `--compare` takes a card
 * fixture and lists its facts that no drafted card seems to cover — a pointer
 * for reading, not a verdict: word overlap misses rewordings.
 *
 * `--dry-run` answers with a stub model instead of the API: free, and the way
 * to check this script still works. Reads the key from the environment only,
 * never from .env.
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dryRun = flag('--dry-run');
const runs = Math.max(1, Number(option('--runs', '2')) || 2);
const comparePath = option('--compare', null);
const source = args.find((arg, i) => !arg.startsWith('--') && !['--runs', '--compare'].includes(args[i - 1]));

const key = process.env.ANTHROPIC_API_KEY;
if (!dryRun && !key) {
  console.error('Set ANTHROPIC_API_KEY in the environment, or pass --dry-run.');
  process.exit(1);
}
if (!dryRun && !source) {
  console.error('Give a URL or a saved .html file to draft.');
  process.exit(1);
}

const BASELINE = fs.readFileSync('tools/fixtures/card-prompt-baseline.txt', 'utf8');
const SAMPLE = `<html><body><main><article>
  <h1>Render and commit</h1>
  <h2>Step 1: Trigger a render</h2><p>A component renders on its initial render, or when its state has been updated. Updating state with the set function queues a render.</p>
  <h2>Step 2: React renders your components</h2><p>Rendering is React calling your components to figure out what to display. The process is recursive: nested components are rendered too.</p>
  <h2>Step 3: React commits changes to the DOM</h2><p>React only changes the DOM nodes if there is a difference between renders. After committing, the browser repaints the screen.</p>
</article></main></body></html>`;

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let html = SAMPLE;
let baseUrl = 'https://example.com/';
if (source) {
  if (/^https?:\/\//.test(source)) {
    const response = await realFetch(source);
    if (!response.ok) throw new Error(`Fetching ${source} failed: HTTP ${response.status}`);
    html = await response.text();
    baseUrl = source;
  } else {
    html = fs.readFileSync(source, 'utf8');
  }
}
const { document } = parseHTML(html);
const sections = sectionsFromDocument(document, { baseUrl });
console.log(`${sections.length} sections from ${source ?? 'the built-in sample'}${dryRun ? ' (dry run: stub model)' : ''}`);

// ---------------------------------------------------------------------------
// The swap, and the stub
// ---------------------------------------------------------------------------

let variant = 'current';
const promptsSent = { baseline: new Set(), current: new Set() };

/** A pretend model for --dry-run: a few cards per section, some deliberately flawed. */
function stubReply(body) {
  const payload = JSON.parse(body.messages[0].content);
  const first = payload[0].source;
  // One of each problem, planted so the dry run can check the measures count
  // them: a real repeat (the deck's c3/c7 pair), a look-alike that is not one,
  // a yes/no front, a name asked for by its job, and a front pointing at an
  // example the card does not show.
  const cards = [
    { front: 'What are the three steps of a React screen update?', back: 'Trigger, Render, and Commit.' },
    { front: 'Which three steps does React use to display UI?', back: '1) Triggering a render, 2) Rendering the component, 3) Committing to the DOM.' },
    { front: 'In this example, what does React do first?', back: 'It triggers a render.' },
    { front: 'Does the browser repaint after React commits?', back: 'Yes, the browser repaints the screen.' },
    { front: 'What tool can help find mistakes in React components?', back: 'Strict Mode.' },
  ].map((card) => ({ ...card, source: first, context: 'Stub' }));
  return { content: [{ type: 'text', text: JSON.stringify(cards) }], stop_reason: 'end_turn' };
}

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const system = body.system?.[0]?.text;
  if (system === CARD_SYSTEM_PROMPT && variant === 'baseline') {
    body.system[0].text = BASELINE;
  }
  promptsSent[variant].add(body.system?.[0]?.text === BASELINE ? 'baseline' : system === CARD_SYSTEM_PROMPT ? 'current' : 'other');
  if (dryRun) {
    const reply = stubReply(body);
    return { ok: true, status: 200, json: async () => reply, text: async () => JSON.stringify(reply) };
  }
  return realFetch(url, { ...init, body: JSON.stringify(body) });
};

// ---------------------------------------------------------------------------
// Measures
// ---------------------------------------------------------------------------

/**
 * Answer pairs worth a person's look as possible repeats — a reading list, not
 * a count. Word matching cannot decide it: the two "three steps" cards of the
 * render-and-commit deck ("1) Triggering a render, 2) Rendering the component,
 * 3) Committing to the DOM." / "Trigger, Render, and Commit.") share only a
 * quarter of their words as the app's own contentWords sees them, while "It
 * triggers a render." shares two thirds of the second. So the rule here is
 * loose and one-way: every word of the shorter answer appears in the longer,
 * comparing word beginnings so "committing" meets "commit", and ignoring list
 * numbers. Answers under three words are too short to judge this way.
 */
function answerWords(text) {
  return new Set(
    [...contentWords(text)].filter((word) => !/^\d+$/.test(word)).map((word) => word.slice(0, 5))
  );
}
function possibleRepeats(cards) {
  const pairs = [];
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const [x, y] = [answerWords(cards[i].back), answerWords(cards[j].back)];
      const [short, long] = x.size <= y.size ? [x, y] : [y, x];
      if (short.size >= 3 && [...short].every((word) => long.has(word))) pairs.push([cards[i], cards[j]]);
    }
  }
  return pairs;
}

const YES_NO = /^(does|do|did|is|are|was|were|can|could|will|would|should|has|have|had)\b/i;
/** A name answer asked for by the job it does — rule 8's common case. A pointer, not a verdict. */
const NAME_BY_JOB =
  /^(what|which) (tool|tools|feature|features|mode|method|technique|approach|api|function|hook|library|option|setting)s? (can|could|would|should|might|helps?|is used|are used|do you use|lets?)\b|^what can (you|developers|one|a developer) use\b/i;

function measure(result) {
  const cards = result.cards;
  return {
    cards,
    total: cards.length,
    fallback: result.fallbackCards.length,
    repeats: possibleRepeats(cards),
    yesNo: cards.filter((c) => YES_NO.test(c.front.trim())),
    nameByJob: cards.filter((c) => NAME_BY_JOB.test(c.front.trim())),
    dangling: cards.filter((c) => danglingReference(c)),
    withImage: cards.filter((c) => c.image),
  };
}

const fixture = comparePath ? JSON.parse(fs.readFileSync(comparePath, 'utf8')) : null;
/** Fixture facts that no drafted card overlaps by half its words, front or back. */
function uncovered(cards) {
  if (!fixture) return [];
  return fixture.filter((fact) => {
    let best = 0;
    for (const card of cards) {
      best = Math.max(best, overlapRatio(fact.back, card.back), overlapRatio(fact.front, card.front));
    }
    return best < 0.5;
  });
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

// A dry run never uses the real key, and must not be stopped by an empty one:
// the other harnesses are run with ANTHROPIC_API_KEY= to keep them offline,
// and an empty key passed through makes the transport refuse the stub call.
const settings = { mode: 'byok', apiKey: dryRun ? 'dry-run' : key };
const results = { baseline: [], current: [] };
for (const which of ['baseline', 'current']) {
  variant = which;
  for (let run = 1; run <= runs; run++) {
    process.stdout.write(`  drafting with the ${which} prompt, run ${run} of ${runs}…\n`);
    const result = await generateCandidatesWithAi(sections, settings, {});
    results[which].push({ ...measure(result), lost: uncovered(result.cards), failedBatches: result.failedBatches });
  }
}

const wrongPrompt = [...promptsSent.baseline].some((p) => p !== 'baseline') || [...promptsSent.current].some((p) => p !== 'current');
if (wrongPrompt) {
  console.error(`\nThe prompt swap misfired: ${JSON.stringify({ baseline: [...promptsSent.baseline], current: [...promptsSent.current] })}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const columns = [
  ...results.baseline.map((_, i) => `old ${i + 1}`),
  ...results.current.map((_, i) => `new ${i + 1}`),
];
const all = [...results.baseline, ...results.current];
const rows = [
  ['cards', (r) => r.total],
  ['answer pairs to check (possible repeats)', (r) => r.repeats.length],
  ['yes/no fronts', (r) => r.yesNo.length],
  ['name-by-job fronts (possible)', (r) => r.nameByJob.length],
  ['fronts pointing at the unseen', (r) => r.dangling.length],
  ['cards with a picture', (r) => r.withImage.length],
  ['failed batches', (r) => r.failedBatches],
  ...(fixture ? [[`fixture facts not covered (of ${fixture.length})`, (r) => r.lost.length]] : []),
];
console.log(`\n| | ${columns.join(' | ')} |`);
console.log(`|---|${columns.map(() => '---').join('|')}|`);
for (const [label, get] of rows) console.log(`| ${label} | ${all.map(get).join(' | ')} |`);

function details(which) {
  results[which].forEach((r, i) => {
    console.log(`\n${which.toUpperCase()} PROMPT, run ${i + 1}`);
    for (const [a, b] of r.repeats) console.log(`  REPEAT?  "${a.front}" -> "${a.back}"\n           "${b.front}" -> "${b.back}"`);
    for (const c of r.yesNo) console.log(`  YES/NO   ${c.front}`);
    for (const c of r.nameByJob) console.log(`  BY JOB?  ${c.front} -> ${c.back}`);
    for (const c of r.dangling) console.log(`  UNSEEN   ${c.front}`);
    for (const c of r.withImage) console.log(`  PICTURE  ${c.front}`);
    for (const c of r.lost) console.log(`  LOST?    ${c.id ?? ''} ${c.front}`);
  });
}
details('baseline');
details('current');

console.log(
  '\nRead the LOST? lines by hand: a fact reworded beyond word overlap is listed even though it was kept.\n' +
    'A difference counts when it shows in every run of one prompt and in none of the other.'
);
if (dryRun) {
  // The stub plants exactly one of each problem; every run must count each once.
  const expected = { repeats: 1, yesNo: 1, nameByJob: 1, dangling: 1, withImage: 0 };
  const wrong = all.flatMap((r, i) =>
    Object.entries(expected)
      .filter(([measure, count]) => r[measure].length !== count)
      .map(([measure, count]) => `${columns[i]}: ${measure} counted ${r[measure].length}, planted ${count}`)
  );
  if (wrong.length > 0) {
    console.error(`\nDry run FAILED:\n  ${wrong.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\nDry run passed: the prompt swap worked, and every measure counted its planted case.');
}
