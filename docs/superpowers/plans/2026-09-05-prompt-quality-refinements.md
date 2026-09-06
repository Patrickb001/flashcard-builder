# Prompt Quality Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the AI card-splitting rule and the recall-quiz distractor rules so cards split consistently and invented wrong answers are genuinely close misses, then verify both changes against real model output and bring `docs/tuning-notes.md` up to date with what was found.

**Architecture:** This is a prompt-text change to two existing system prompts (`CARD_SYSTEM_PROMPT` in `src/lib/cardPrompt.ts`, `QUIZ_SYSTEM_PROMPT` in `src/lib/quizPrompt.ts`), plus one small observability addition in `src/lib/quizGenerator.ts` so the vignette audit's reject rate is visible when it runs. No data shapes, parsers, or public function signatures change. Because prompt-text quality cannot be asserted, verification follows this project's own established pattern (`tools/test-quiz.mjs`, `tools/test-vignette.mjs`, `tools/test-ai-cards.mjs`): call the real model against fixture data and read the output, with only structural counts checked by assertion.

**Tech Stack:** TypeScript, Node (`--experimental-strip-types`), Anthropic API (`claude-sonnet-5`), Vite/React app (untouched by this plan).

**Spec:** No separate spec document — this was scoped as a bounded task in conversation (the flows already exist; this is a targeted edit to established prompts, not a new subsystem). The agreed design is captured in this plan: (1) rewrite the ATOMIC card-splitting rule as an ordered three-branch test instead of one run-on conditional sentence, (2) rewrite the quiz "plausible, not absurd" rule with a concrete technique for inventing a distractor plus a worked example, and tell the model the neighbours list is ordered nearest-topic-first, (3) evaluate `docs/tuning-notes.md` for drift against the code it documents and fold in real findings from this work.

## Global Constraints

- `CARD_SYSTEM_PROMPT` and `QUIZ_SYSTEM_PROMPT` are TypeScript template literals (backtick strings) — new rule text must not contain a backtick or a `${` sequence, or the file stops compiling.
- Keep existing rule numbering in both prompts (cards 1–7, quiz 1–6 plus the "Using the neighbouring cards" section) — other rules and this plan's own new text cross-reference rule numbers by number (e.g. "keep to rule 4 and rule 6"), and downstream prose in the file refers to rules by number too.
- Do not change `LlmCard`, `LlmQuizQuestion`, or any parser's accepted shape — this plan is prompt text and one log line, not a schema change.
- `MAX_TOKENS` must stay identical between `src/lib/aiTransport.ts` and `src/server/generateHandler.ts` (pre-existing constraint). This plan only documents the existing `vignette-audit: 1000` value in `docs/tuning-notes.md`; it does not change any ceiling.
- Steps that call the real Anthropic API cost real money and only run when `ANTHROPIC_API_KEY` is set (via shell env or a `.env` file read the same way every `tools/test-*.mjs` script already reads it). If no key is available when a task is executed, run the step, let it print "Skipped — set ANTHROPIC_API_KEY to run it," and say so plainly in `docs/tuning-notes.md` rather than inventing a result.

---

### Task 1: Rewrite the ATOMIC card-splitting rule

**Files:**
- Modify: `src/lib/cardPrompt.ts` (rule 1 of `CARD_SYSTEM_PROMPT`, currently the single sentence starting `1. ATOMIC`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `CARD_SYSTEM_PROMPT` (same export, same name, text only changes). Later tasks in this plan do not depend on this rule's exact wording, only on the file still exporting `CARD_SYSTEM_PROMPT` and still compiling.

- [ ] **Step 1: Replace rule 1's text**

In `src/lib/cardPrompt.ts`, find this exact paragraph (currently line 23):

```
1. ATOMIC — one fact per card. Split compound statements into separate cards, unless the source presents a small, bounded set of parallel items that only mean anything together (the two types of memory, the four attachment styles) — those may share one card with a list back. Split the moment any item carries its own distinct detail worth recalling on its own — its own range, mechanism, or classification.
```

Replace it with:

```
1. ATOMIC — one fact per card. Test every statement in this order:
   - It carries its own distinct, checkable detail — a number, a mechanism, a range, a named sub-type — even when the source shares it in one sentence with others: split it out on its own. "Avoidant attachment appears in about 25% of the population; anxious attachment in about 10%" is two cards, one per figure, even though the source names both styles together.
   - Otherwise, it is one of a small, bounded set (two to six) of parallel items that only mean anything together, with no item carrying a detail of its own: keep them on one card with a list back. "The four attachment styles are secure, avoidant, anxious, and disorganized" is one card naming all four, because none carries a detail here.
   - Otherwise — more than six such items with nothing distinguishing any one of them — split into smaller groupings of two to six, following any subgrouping the source itself gives, or else in the order given. A back with eight or more items is not something a student can hold in memory as a single answer.

   A descriptive adjective or a longer clause is not, on its own, a "distinct detail" — do not split an item merely because its sentence runs longer than its neighbours'.
```

- [ ] **Step 2: Confirm the file still compiles**

Run: `npx tsc -b`
Expected: exits 0, no errors from `src/lib/cardPrompt.ts` (a stray backtick or `${` in the new text is the one way this step would fail).

- [ ] **Step 3: Commit**

```bash
git add src/lib/cardPrompt.ts
git commit -m "Rewrite the ATOMIC card-splitting rule as an ordered test"
```

---

### Task 2: Rewrite the quiz distractor rules and the neighbour-ordering note

**Files:**
- Modify: `src/lib/quizPrompt.ts` (rule 4, rule 6, and point 1 of "Using the neighbouring cards" inside `QUIZ_SYSTEM_PROMPT`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `QUIZ_SYSTEM_PROMPT` (same export, text only changes).

- [ ] **Step 1: Replace rule 4**

Find this exact paragraph:

```
4. EVERY WRONG ANSWER MUST BE UNAMBIGUOUSLY WRONG for this stem. This is the rule that matters most. A distractor that is arguably also correct makes the question unanswerable and marks a student wrong for knowing the material. Where the deck itself offers nothing plausible, write the wrong answers from the subject matter instead — but they must still be clearly and defensibly wrong. This is the one rule you may never trade away for coverage.
```

Replace it with:

```
4. EVERY WRONG ANSWER MUST BE UNAMBIGUOUSLY WRONG for this stem. This is the rule that matters most. A distractor that is arguably also correct makes the question unanswerable and marks a student wrong for knowing the material. This is the one rule you may never trade away for coverage — but "unambiguously wrong" is not license to make it unambiguously irrelevant instead; see rule 6 for what to invent when the deck itself offers nothing plausible.
```

- [ ] **Step 2: Replace rule 6**

Find this exact paragraph:

```
6. PLAUSIBLE, NOT ABSURD — a wrong answer should be something a student who half-learned the material might believe. Joke options and obvious nonsense teach nothing, and so do "all of the above" or "none of the above" — they let a student skip the material instead of recalling it.
```

Replace it with:

```
6. PLAUSIBLE, NOT ABSURD — a wrong answer should be something a student who half-learned the material might believe. Joke options and obvious nonsense teach nothing, and so do "all of the above" or "none of the above" — they let a student skip the material instead of recalling it.

When you must invent a distractor instead of drawing one from the neighbours, do not reach for any true, unrelated fact and declare it wrong — a student eliminates that by category alone, which defeats the question as surely as an absurd option does. Mutate the correct answer along one axis instead: the adjacent value on the same scale, the sibling term in the same classification, the step before or after it in the same process, or a mechanism from the same family that is not the one being tested. For a card whose answer is "Repeats a block a fixed number of times" (a for loop), prefer "Repeats a block until a condition becomes false" over "Declares a new namespace" as the invented wrong answer — the first is a different real construct from the same family a half-learned student could confuse it with; the second is true of something else entirely and gives itself away on sight.
```

- [ ] **Step 3: Add the neighbour-ordering note**

Find this exact paragraph (point 1 under "Using the neighbouring cards:"):

```
1. WRONG ANSWERS. PREFER a neighbour's answer. The best distractor is a near miss the deck itself contains — the adjacent stage in a sequence, a sibling term, the next row of the same table — because it tests whether the student can tell two real things apart. Write your own only when the neighbours offer nothing plausible, and when you do, stay inside the deck's subject matter and keep to rule 4: clearly wrong, not merely unmentioned. Never reuse the correct answer, in any wording, as a wrong answer.
```

Replace it with:

```
1. WRONG ANSWERS. PREFER a neighbour's answer. The neighbours are listed nearest-topic-first, so check the earliest ones before settling for one further down the list or inventing your own — an early neighbour is more likely to share this card's specific topic. The best distractor is a near miss the deck itself contains — the adjacent stage in a sequence, a sibling term, the next row of the same table — because it tests whether the student can tell two real things apart. Write your own only when the neighbours offer nothing plausible, and when you do, stay inside the deck's subject matter and keep to rule 4 (clearly wrong, not merely unmentioned) and rule 6 (a genuine near miss, not merely a safe fact). Never reuse the correct answer, in any wording, as a wrong answer.
```

- [ ] **Step 4: Confirm the file still compiles**

Run: `npx tsc -b`
Expected: exits 0, no errors from `src/lib/quizPrompt.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/quizPrompt.ts
git commit -m "Tighten quiz distractor rules and note the neighbours' ordering"
```

---

### Task 3: Log the vignette audit's reject count

**Files:**
- Modify: `src/lib/quizGenerator.ts` (`auditVignettes`, currently lines 342–374)

**Interfaces:**
- Consumes: `parseAuditResponse` from `./quizPrompt` (unchanged).
- Produces: no interface change — `auditVignettes` still returns `Promise<LlmQuizQuestion[]>`. This step only adds a `console.warn` so a real run (Task 6) can report how many vignette questions the audit flagged, which `docs/tuning-notes.md`'s existing "Open, not yet done" note explicitly asks someone to measure.

- [ ] **Step 1: Add the log line**

In `src/lib/quizGenerator.ts`, find this exact block inside `auditVignettes`:

```typescript
  try {
    // Wrapped in an array for the same reason the generation call is: the
    // endpoint's contract is a non-empty list of things for the model, even
    // when — as here — there is only one thing to send.
    const { text } = await callModel('vignette-audit', [{ context, questions }], settings, signal);
    const verdicts = parseAuditResponse(text);
    return parsed.filter((item) => verdicts.get(item.id) === true);
  } catch (err) {
    console.error('Vignette audit failed; dropping the batch rather than trusting it unaudited:', err);
    return [];
  }
```

Replace it with:

```typescript
  try {
    // Wrapped in an array for the same reason the generation call is: the
    // endpoint's contract is a non-empty list of things for the model, even
    // when — as here — there is only one thing to send.
    const { text } = await callModel('vignette-audit', [{ context, questions }], settings, signal);
    const verdicts = parseAuditResponse(text);
    const kept = parsed.filter((item) => verdicts.get(item.id) === true);
    const flagged = parsed.length - kept.length;
    // The reject rate itself is what docs/tuning-notes.md's vignette-audit
    // entry needs measured: too high means the audit prompt is too strict,
    // never rejecting even a planted bad distractor means it is too lax.
    if (flagged > 0) {
      console.warn(`Vignette audit flagged ${flagged} of ${parsed.length} question(s); dropped for retry.`);
    }
    return kept;
  } catch (err) {
    console.error('Vignette audit failed; dropping the batch rather than trusting it unaudited:', err);
    return [];
  }
```

- [ ] **Step 2: Confirm the file still compiles**

Run: `npx tsc -b`
Expected: exits 0, no errors from `src/lib/quizGenerator.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/quizGenerator.ts
git commit -m "Log the vignette audit's reject count for tuning visibility"
```

---

### Task 4: Run the existing offline test suite

**Files:**
- None modified — this task only runs existing tools to confirm Tasks 1–3 did not break parsing, selection, or compilation.

**Interfaces:**
- Consumes: `tools/test-payload.mjs`, `tools/test-quiz.mjs`, `tools/test-vignette.mjs`, `tools/test-coverage.mjs`, `tools/test-neighbour-context.mjs` (all pre-existing, unmodified).
- Produces: nothing persisted — a pass/fail read for this task's own record-keeping in Task 7.

- [ ] **Step 1: Typecheck the whole project**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 2: Run the offline parts of every test tool that imports the three edited files**

```bash
node --experimental-strip-types --import ./tools/register.mjs tools/test-payload.mjs
node --experimental-strip-types --import ./tools/register.mjs tools/test-quiz.mjs
node --experimental-strip-types --import ./tools/register.mjs tools/test-vignette.mjs
node --experimental-strip-types --import ./tools/register.mjs tools/test-coverage.mjs
node --experimental-strip-types --import ./tools/register.mjs tools/test-neighbour-context.mjs
```

Expected: every script prints `All checks passed.` and exits 0. (Each script's own "Part 3 — real generation" section will print "GENERATION skipped — set ANTHROPIC_API_KEY to run it" if no key is configured; that is expected here and is exercised for real in Tasks 5 and 6.)

None of these assertions read prompt wording, so a failure here would mean Tasks 1–3 broke a type, an export name, or `auditVignettes`' control flow — not the rule text itself.

- [ ] **Step 3: Note the result**

No commit for this task (nothing changed); carry the pass/fail result forward into Task 7's `docs/tuning-notes.md` update.

---

### Task 5: Add a synthetic fixture tool for the splitting rule and run it

**Files:**
- Create: `tools/test-card-splitting.mjs`

**Interfaces:**
- Consumes: `generateCandidatesWithAi` from `../src/lib/aiGenerator.ts` (unchanged signature: `(sections: DocumentSection[], settings: AiSettings, options?) => Promise<AiGenerationResult>`).
- Produces: printed output for a human to read, plus three structural `check()` assertions on card counts per section — not a claim that the split is pedagogically correct, only that it isn't obviously wrong (e.g. one card holding all nine list items).

There is no PDF fixture in this repo that reliably exercises rule 1's three branches on demand, and building one from a real document would be undirected. This task builds three minimal synthetic sections that sit exactly on the rule's three branches instead, the same way a unit test isolates one behavior rather than exercising it incidentally through a full document.

- [ ] **Step 1: Write the tool**

Create `tools/test-card-splitting.mjs`:

```javascript
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

console.log('Drafting 3 synthetic sections\n');

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
  byLabel('Section 3').length !== 1,
  `got ${byLabel('Section 3').length} card(s) for 9 items`
);
if (result.firstError) console.log(`\n  !! ${result.firstError}`);

console.log(
  '\n  Read the cards above: Section 1 should show each figure on its own card,\n' +
    '  Section 2 should read as one card naming all four styles, and Section 3\n' +
    '  should be split into smaller groupings rather than one long list-back card.'
);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} CHECK(S) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-card-splitting.mjs`

If `ANTHROPIC_API_KEY` is set (shell env or `.env`), expected: prints cards for all three sections and `All checks passed.` Read the printed cards against the comment at the end of the script — this is the actual verification of Task 1, not the three structural checks alone.

If no key is set, expected: prints `Skipped — set ANTHROPIC_API_KEY to run it.` and exits 0. Record that verification was skipped — do not mark rule 1 as confirmed working in Task 7 if this happens.

- [ ] **Step 3: Commit**

```bash
git add tools/test-card-splitting.mjs
git commit -m "Add a synthetic fixture tool for the ATOMIC splitting rule"
```

---

### Task 6: Run real-model validation for the quiz and vignette prompts

**Files:**
- None modified — this task runs existing tools against existing fixtures.

**Interfaces:**
- Consumes: `tools/test-quiz.mjs` against `tools/fixtures/quiz-cards.json`, `tools/test-vignette.mjs` against `tools/fixtures/pance-cards.json` (both pre-existing, unmodified).
- Produces: printed distractors for a human to read (verifying Task 2), and — because Task 3 added the audit log — a printed count of how many vignette questions the audit flagged (closing the specific measurement `docs/tuning-notes.md` already asks for).

- [ ] **Step 1: Run the recall-quiz generation tool**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-quiz.mjs`

If a key is present, expected: `All checks passed.`, plus a printed list of stems, correct answers, and distractors. Read every distractor against rule 4 (unambiguously wrong) and rule 6 (a genuine near miss, not a safe unrelated fact) from Task 2. If no key is present, expected: `GENERATION skipped — set ANTHROPIC_API_KEY to run it.`

- [ ] **Step 2: Run the vignette generation tool and watch for the audit log**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-vignette.mjs`

If a key is present, expected: `All checks passed.`, plus printed vignettes and options, and — for any batch the audit flagged at least one question in — a line from Task 3 reading `Vignette audit flagged N of M question(s); dropped for retry.` Record the total flagged and total generated across the run (e.g. "3 of 12 flagged" — sum across every printed line) for Task 7. If no line prints at all, the audit did not flag anything in this run; record that too, since "never rejects" is itself a data point `docs/tuning-notes.md` calls out as worth knowing. If no key is present, expected: `GENERATION skipped — set ANTHROPIC_API_KEY to run it.` printed before Part 3.

- [ ] **Step 3: No commit**

Nothing changes in this task; carry both readings forward into Task 7.

---

### Task 7: Update `docs/tuning-notes.md`

**Files:**
- Modify: `docs/tuning-notes.md`

**Interfaces:**
- Consumes: the results recorded in Tasks 4, 5, and 6.
- Produces: nothing consumed by code — this file is documentation only, read by future contributors per its own header ("Anyone changing one of these numbers should read its section first").

- [ ] **Step 1: Add the missing `vignette-audit` row to the ceilings table**

Find this exact table in the "Model response ceilings" section:

```
| Task | Ceiling |
|---|---|
| `cards` | 16000 |
| `quiz` | 8000 |
| `vignette` | 16000 |
```

Replace it with:

```
| Task | Ceiling |
|---|---|
| `cards` | 16000 |
| `quiz` | 8000 |
| `vignette` | 16000 |
| `vignette-audit` | 1000 |
```

Immediately below the existing "**Why the headroom is close to free.**" paragraph in that same section, add:

```

**Vignette-audit — why 1000.** The audit call returns one verdict object per question in the batch — an id and a boolean — never prose, so it costs a small fraction of what generating the batch did. This was a starting estimate, not a measured one, when it shipped; see the 2026-09-05 entry below for whether a real run needed more.
```

- [ ] **Step 2: Resolve the 2026-09-05 entry's open item**

Find this exact closing paragraph of the existing 2026-09-05 entry:

```
**Open, not yet done:** none of this has been run against real output. Before trusting it: run cards against `tools/fixtures/pages/*.html` and a list-heavy source; run both quiz styles on a real clinical deck and watch the audit pass's actual reject rate (too high means its own prompt is too strict; never rejecting even an obviously bad planted distractor means it's too lax to trust); and — since none of this had a temperature set before, and still doesn't — if a lower temperature is tried, score it by the audit pass's flag count rather than by eye alone, and record the result here either way.
```

Replace it with (fill in the bracketed results using what Tasks 4–6 actually produced — do not write a specific number or "passed" if the corresponding step printed "Skipped"):

```
**Resolved 2026-09-05:** run for real as part of the prompt-quality-refinements plan. Offline parsing, selection, and compilation checks (Task 4 of that plan) [passed / — state what actually happened]. The audit pass's reject rate over the vignette fixture run (Task 6) was [N flagged of M generated / not measured — no API key available]. Temperature was still not touched in this pass; that remains open below.
```

- [ ] **Step 3: Append a new entry for this task's own changes**

At the end of the file, after the existing 2026-09-05 entry, add:

```

---

## 2026-09-05 — splitting-rule rewrite and distractor plausibility

**Cards — rule 1 (ATOMIC) restructured as an ordered test.** The prior wording packed two conditionals into one sentence ("split X, unless Y — but split anyway if Z"), which is a shape models apply inconsistently: reports of both over-splitting (a plain descriptive clause treated as a "distinct detail") and under-splitting (a number embedded in a shared sentence not triggering a split) were coming from the same rule. Rewritten as three ordered branches with a worked example pair, and a new explicit bound: a parallel set of more than six items with no per-item detail must now be split into smaller groupings rather than staying on one long list-back card — closing the exact gap the previous entry flagged as untested ("worth checking against an 8+ item list, where it should still force a split"). Verified with a new synthetic-fixture tool, `tools/test-card-splitting.mjs`, rather than a real document — see that file's own comment for why a directed fixture was chosen over an incidental one. [Fill in: what the fixture run actually showed, once Task 5 has been run with a key.]

**Quiz — rules 4 and 6 no longer pull against each other for invented distractors.** Rule 4's "unambiguously wrong" framing (already the strongest rule in the file) gave no guidance on invented distractors beyond "clearly and defensibly wrong," which a model can satisfy with a safely irrelevant fact — plausible-sounding to no one, and arguably the source of "not close enough" reports. Rule 6 now carries a concrete technique (mutate the correct answer along one axis: adjacent value, sibling term, adjacent step, same-family mechanism) with a worked good/bad pair, and rule 4 now points forward to it instead of duplicating "write your own" guidance in two places.

**Quiz — the model was never told the neighbours list is ordered.** `quizGenerator.ts`'s `nearestFirst` (topic, then source page, then the rest) has ranked neighbours since before this entry, but `QUIZ_SYSTEM_PROMPT` never said so — the model had no reason to prefer an early entry over a later one. Added one sentence to point 1 of "Using the neighbouring cards."

**Quiz — the vignette audit's reject rate is now visible.** `auditVignettes` in `quizGenerator.ts` dropped flagged questions silently; it now logs how many of a batch were flagged, which is what the previous entry's open item asked someone to go measure. [Fill in: the actual flagged/generated counts from Task 6, once run with a key.]

**Still open:** temperature has still never been set on any of these calls; if it is tried, score it by the vignette audit's flag count (now logged) rather than by eye alone.
```

- [ ] **Step 4: Commit**

```bash
git add docs/tuning-notes.md
git commit -m "Update tuning-notes.md: missing ceiling row and prompt-refinement results"
```
