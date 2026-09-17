# Infographic HTML Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Provenance:** this file merges `docs/superpowers/plans/2026-09-16-infographic-html-pipeline.md`'s original 10 tasks with the amendments proposed in `docs/superpowers/plans/2026-09-16-infographic-html-pipeline-gaps.md` (Tasks A-F there). Both source documents still exist for history; this file is the single, renumbered, corrected source of truth to execute from — do not extract tasks from either source document directly.

**Goal:** Replace the infographic feature's block-based rendering (a fixed `InfographicBlock` union drawn through typed React components) with a two-call pipeline — an extraction call that turns a deck's chosen flashcards into structured JSON, then a design call that turns that JSON into one self-contained HTML document with inline CSS and inline SVG — rendered through a sandboxed `<iframe>`, styled with this app's own color tokens so it matches the app in light and dark mode, with real cancellation and stage feedback while it generates.

**Architecture:** `infographicGenerator.ts` makes two sequential `callModel` calls instead of one: `infographic-extract-{basic,standard,detailed}` (cards in, a small structured-content JSON object out) and `infographic-design` (that JSON in, a full HTML document out), reporting which stage is running via an `onStage` callback and accepting a real `AbortSignal`. The stored `Infographic` record keeps `title`/`detail`/`cardIds`/`createdAt` as before but swaps `blocks: InfographicBlock[]` for `html: string`. `InfographicView` renders that string through `<iframe sandbox="allow-same-origin" srcDoc={html}>` — no `allow-scripts`, so nothing the model wrote can execute — and mirrors the app's current theme onto the iframe's root element and auto-sizes its height via `ResizeObserver`. The design call's reply is sanitized by parsing it into a real DOM (`linkedom`) and structurally removing dangerous nodes/attributes, rather than pattern-matching strings.

**Tech Stack:** TypeScript, React 18, IndexedDB (`idb`), `linkedom` (moved from devDependency to runtime dependency — see Task 3), the existing `callModel`/`AiTask` transport shared between the browser (BYOK) and a Netlify function (hosted).

**Spec:** `docs/superpowers/specs/infographic-pipeline-spec.md` (the two-call pipeline and design-system reference this plan implements), read alongside `docs/superpowers/specs/2026-09-13-flashcard-infographic-design.md` and `docs/superpowers/specs/2026-09-15-infographic-block-schema-design.md` (the shipped feature this plan replaces — storage, routing, and AI gating from those two specs are unchanged and not repeated here).

## Why this replaces rather than extends the shipped feature

The shipped feature's `2026-09-13` spec made a deliberate call: infographics are structured JSON rendered through components this app owns, "never arbitrary HTML the model writes," specifically to avoid needing iframe sandboxing. This plan reopens that call on explicit direction: the new pipeline renders the model's own HTML/SVG through a sandboxed iframe, with the app's real color tokens handed to the design call so the result still looks like it belongs to this app rather than looking arbitrary. Task 9 below is where that sandboxing is implemented; treat its `sandbox` attribute as load-bearing, not incidental.

One line from `infographic-pipeline-spec.md` is intentionally not carried over: "Reuse this same JSON as the source for flashcard generation too." In this app, a deck's flashcards already exist (from `cardPrompt.ts`'s own document-parsing pipeline) before an infographic can be requested — `DeckManager.tsx`'s "Create infographic" button is disabled until `cards.length > 0`. There is no "raw study material in, flashcards and an infographic out together" moment for this extraction JSON to feed both from; it only ever runs after the fact, from cards that already exist. This is scoped out, not overlooked.

## Global Constraints

- Never render the model's HTML via `dangerouslySetInnerHTML`. It is only ever set as an `<iframe>`'s `srcDoc`, with `sandbox="allow-same-origin"` and **no** `allow-scripts` — see Task 9. This is the primary security control; the sanitizer in Task 3 is defense-in-depth on top of it, not a substitute for it.
- `src/lib/infographicPrompt.ts` must import nothing DOM/browser-only at runtime — the Netlify function (`netlify/functions/generate.mts`, via `src/server/generateHandler.ts`) imports it directly into the server bundle. `linkedom` (Task 3) is safe here specifically because it is a pure-JS DOM implementation with no `window`/browser dependency, not because this constraint is being relaxed.
- `MAX_TOKENS` for every `infographic-*` task must be numerically identical between `src/lib/aiTransport.ts` and `src/server/generateHandler.ts`, or hosted and BYOK mode draft under different ceilings from the same input. Task 5 adds an automated test for this so future drift is caught rather than relying on someone re-reading this plan.
- Every payload sent through `callModel` / `handleGenerate` must be a non-empty JSON **array** — `handleGenerate` (`src/server/generateHandler.ts`) rejects anything else with `Expected a non-empty "sections" array`. The design call's payload is one JSON object, so it travels as a single-element array: `[extracted]`.
- The color tokens embedded in the design prompt (Task 3) are hand-copied from `src/index.css`'s `:root` and `:root[data-theme="dark"]` blocks. This file cannot `import` CSS, so if those hex values ever change in `index.css`, `INFOGRAPHIC_DESIGN_PROMPT` must be updated by hand to match — Task 5 adds an automated test for this too.
- `sanitizeInfographicHtml` (Task 3) is not guaranteed to return its input unchanged even when the input was already clean — parsing and re-serializing through a real DOM can normalize whitespace, attribute quoting, or insert an implied element. Tests against it must assert on content/structure, never on byte-for-byte string equality.

## What does not change

Storage plumbing (`src/db/db.ts`'s object store/index shape, `saveInfographic`, `deleteInfographic`, `deleteDeck`'s cleanup), routing (`/deck/:deckId/infographic`), AI gating (`AiSettingsPanel`), and the delete-confirmation `Modal` flow in `InfographicList.tsx`/`InfographicView.tsx` — none of these are touched. `InfographicSetup.tsx`'s behavior (detail level + card scope choice) is unchanged; only its copy is updated (Task 11). `InfographicMode.tsx`'s phase machine keeps its same four phases, but Task 7 below gives it real cancellation and stage feedback it didn't have before — this is a behavior change from the *shipped* feature, addressed explicitly rather than left as a gap.

---

### Task 1: Data model — swap `blocks` for `html`

**Files:**
- Modify: `src/types.ts`

**Interfaces:**
- Produces: `Infographic` with `html: string` in place of `blocks: InfographicBlock[]`. Every later task reads/writes this field by that exact name.

- [ ] **Step 1: Remove the block-union types and the now-unused icon enum**

In `src/types.ts`, delete these exports entirely: `InfographicIcon`, `BulletsBlock`, `TimelineBlock`, `TableBlock`, `CalloutBlock`, `StatBlock`, `CompareColumn`, `CompareBlock`, `StepsBlock`, `QuoteBlock`, `InfographicBlock`, and `LlmInfographic`. Keep `InfographicDetail` exactly as it is — the Setup screen's Basic/Standard/Detailed choice is unchanged.

- [ ] **Step 2: Change `Infographic` to carry `html` instead of `blocks`**

Replace the `Infographic` interface with:

```ts
/**
 * One saved infographic. A deck can have any number of these — different
 * detail levels or card subsets are different infographics, not versions of
 * one, so there is no "the deck's infographic" singular and no overwrite.
 *
 * `html` is the model's own self-contained HTML document — inline CSS and
 * inline SVG, no external JS or images (see infographicPrompt.ts). It is
 * rendered through a sandboxed iframe (InfographicView.tsx), never through
 * this app's own DOM.
 */
export interface Infographic {
  id: string;
  deckId: string;
  title: string;
  detail: InfographicDetail;
  html: string;
  /** Which cards this one was built from, for the list screen's "N cards" line. */
  cardIds: string[];
  createdAt: number;
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: Errors in every file that still references the removed types/field — `src/lib/infographicPrompt.ts`, `src/lib/infographicGenerator.ts`, `src/db/db.ts`, `src/components/infographic/blocks.tsx`, `src/components/infographic/icons.tsx`, `src/components/infographic/InfographicView.tsx`, `src/components/infographic/InfographicList.tsx`. That's expected — later tasks fix each one. Confirm the errors are exactly in those files and nowhere else (e.g. not in `InfographicSetup.tsx`, `InfographicMode.tsx`, `DeckManager.tsx`).

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "infographic: swap the block union for a stored html string"
```

---

### Task 2: Extraction call — prompt and parser

**Files:**
- Modify: `src/lib/textUtils.ts`
- Modify: `src/lib/infographicPrompt.ts` (rewrite)
- Modify: `tools/test-infographic.mjs` (rewrite)

**Interfaces:**
- Consumes: `InfographicDetail` (`src/types.ts`).
- Produces: `INFOGRAPHIC_EXTRACT_PROMPTS: Record<InfographicDetail, string>`, `ExtractedInfographicContent` (with `title: string`, `lede: string`, `coreConcept?: Record<string,string>`, `items: {label:string; detail:string; meta?:string}[]`, `comparisons?: {name:string; value:string}[]`, `keyTakeaway: string`), and `parseExtractionResponse(text: string, deckName: string, detail: InfographicDetail): ExtractedInfographicContent | null`. Task 4 (transport) and Task 6 (generator) import these by these exact names.

- [ ] **Step 1: Widen `stripJsonFence` to strip any fenced code block, not just ` ```json `**

The design call in Task 3 sometimes gets a fenced ` ```html ` block, same as the JSON prompts already tolerate a ` ```json ` fence. In `src/lib/textUtils.ts`, change:

```ts
export function stripJsonFence(text: string): string {
  return text
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
}
```

to:

```ts
export function stripJsonFence(text: string): string {
  return text
    .replace(/^\s*```(?:\w+)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
}
```

This is a strict widening (a bare ` ``` ` or a ` ```json ` fence still strips exactly as before); every existing caller keeps working unchanged.

- [ ] **Step 2: Write the failing tests for extraction parsing**

Replace the top of `tools/test-infographic.mjs` — keep its `check` helper, remove every `bullets`/`callout`/`stat`/etc. block test, replace with:

```js
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
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs`
Expected: FAIL — `parseExtractionResponse`/`INFOGRAPHIC_EXTRACT_PROMPTS` don't exist yet (the module still exports the old block-based names from Task 1's still-unfixed file).

- [ ] **Step 4: Rewrite `src/lib/infographicPrompt.ts`'s extraction half**

Replace the whole file's content up through where the design half will go (Task 3 appends to this same file) with:

```ts
import { stripJsonFence } from './textUtils';
import type { InfographicDetail } from '../types';

/**
 * The infographic pipeline: an extraction call (a deck's flashcards in,
 * structured JSON out) followed by a design call (that JSON in, one
 * self-contained HTML document out). Shared between the browser
 * (bring-your-own-key mode) and the serverless function, exactly as the
 * card and quiz prompts are. This module must import nothing at runtime
 * beyond other such modules — the Netlify function imports it, and a stray
 * reference to the DOM or to localStorage would follow it into the server
 * bundle. (Task 3's `linkedom` import is the one exception, and is safe for
 * this reason: it is a pure-JS DOM implementation with no `window`.)
 */

// ---------------------------------------------------------------------------
// Stage 1: extraction
// ---------------------------------------------------------------------------

export interface ExtractedInfographicItem {
  label: string;
  detail: string;
  meta?: string;
}

export interface ExtractedInfographicComparison {
  name: string;
  value: string;
}

/** What the extraction call returns, and what the design call is given as its whole input. */
export interface ExtractedInfographicContent {
  title: string;
  lede: string;
  /** The single biggest idea, as 2-4 short pairs. Absent when nothing in the material forms one. */
  coreConcept?: Record<string, string>;
  items: ExtractedInfographicItem[];
  /** Present only when the material has 2+ things worth weighing on shared criteria. */
  comparisons?: ExtractedInfographicComparison[];
  keyTakeaway: string;
}

/** Per-level target guidance, folded into each level's own prompt text below. */
const ITEM_TARGET: Record<InfographicDetail, string> = {
  basic: '4-5 items',
  standard: '6-8 items',
  detailed: '8-10 items',
};

/** Parse-time ceilings — a wider safety net than the target above, clamped rather than rejected. */
const ITEM_CEILING: Record<InfographicDetail, number> = { basic: 6, standard: 9, detailed: 12 };
const CORE_CONCEPT_CEILING = 4;
const COMPARISONS_CEILING = 6;

function buildExtractionPrompt(detail: InfographicDetail): string {
  return `You extract the key teachable content from a set of flashcards, so it can be redesigned as a visual infographic in a later step. You are given some flashcards from one deck (front, back, and sometimes a topic).

Do not summarize in prose. Reply with ONLY a JSON object, no prose before or after, shaped exactly like this:

{
  "title": "A short title for the whole infographic",
  "lede": "One sentence, under 25 words, framing what this covers",
  "coreConcept": { "A short label": "a short value", "...": "..." },
  "items": [
    { "label": "A short name", "detail": "One sentence explaining it", "meta": "optional short tag" }
  ],
  "comparisons": [ { "name": "A short name", "value": "What it is on this criterion" } ],
  "keyTakeaway": "One sentence: the single thing to remember"
}

Write ${ITEM_TARGET[detail]} — aim for that range, but it is a guide, not a hard limit; write what the cards actually support.

Rules:
1. GROUNDED — use only facts present in the flashcards. Never add outside knowledge, never invent data, numbers, or examples.
2. SYNTHESIZE, DON'T TRANSCRIBE — an item should read as a distilled idea, not a card's back pasted in verbatim.
3. "coreConcept" is the single biggest idea the material has, as 2-4 short key/value pairs. Omit the field entirely (do not send an empty object) if nothing in the cards forms one central idea.
4. "comparisons" only applies when the cards describe 2 or more things being weighed on the same criteria. Omit the field entirely otherwise.
5. "meta" on an item is optional — a short tag like a number, a category, or a time label. Omit it when nothing short like that applies; never pad it with a made-up value.
6. Keep every string short — this feeds a glance-able visual, not a document.`;
}

/** One prompt per detail level — the level controls how much content the extraction call asks for. */
export const INFOGRAPHIC_EXTRACT_PROMPTS: Record<InfographicDetail, string> = {
  basic: buildExtractionPrompt('basic'),
  standard: buildExtractionPrompt('standard'),
  detailed: buildExtractionPrompt('detailed'),
};

/** Trims and clamps to `max` chars with a trailing ellipsis; null if nothing survives. */
function clampText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

function validateItem(raw: unknown): ExtractedInfographicItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const label = clampText(item.label, 60);
  const detail = clampText(item.detail, 200);
  if (!label || !detail) return null;
  const meta = clampText(item.meta, 40);
  return meta ? { label, detail, meta } : { label, detail };
}

function validateComparison(raw: unknown): ExtractedInfographicComparison | null {
  if (!raw || typeof raw !== 'object') return null;
  const comparison = raw as Record<string, unknown>;
  const name = clampText(comparison.name, 60);
  const value = clampText(comparison.value, 60);
  if (!name || !value) return null;
  return { name, value };
}

function validateCoreConcept(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>)
    .map((entry): [string, string] | null => {
      const key = clampText(entry[0], 40);
      const value = clampText(entry[1], 80);
      return key && value ? [key, value] : null;
    })
    .filter((entry): entry is [string, string] => entry !== null)
    .slice(0, CORE_CONCEPT_CEILING);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Reads the model's reply as one JSON object, tolerating a markdown fence,
 * then validates and clamps each field. Clamps rather than rejects a single
 * item, so one malformed item among several good ones doesn't throw the
 * whole reply away.
 *
 * Returns null only when nothing usable could be read at all: the reply
 * isn't a JSON object, or it parses but zero items survive — items are the
 * substantive content the design call is built around, so a reply with none
 * has nothing worth designing a page from.
 */
export function parseExtractionResponse(
  text: string,
  deckName: string,
  detail: InfographicDetail
): ExtractedInfographicContent | null {
  const cleaned = stripJsonFence(text);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const raw = parsed as Record<string, unknown>;

  const items = Array.isArray(raw.items)
    ? raw.items
        .map(validateItem)
        .filter((item): item is ExtractedInfographicItem => item !== null)
        .slice(0, ITEM_CEILING[detail])
    : [];
  if (items.length === 0) return null;

  const title = clampText(raw.title, 80) ?? deckName;
  const lede = clampText(raw.lede, 220) ?? '';
  const keyTakeaway = clampText(raw.keyTakeaway, 220) ?? '';
  const coreConcept = validateCoreConcept(raw.coreConcept);
  const comparisons = Array.isArray(raw.comparisons)
    ? raw.comparisons
        .map(validateComparison)
        .filter((c): c is ExtractedInfographicComparison => c !== null)
        .slice(0, COMPARISONS_CEILING)
    : undefined;

  return {
    title,
    lede,
    ...(coreConcept ? { coreConcept } : {}),
    items,
    ...(comparisons && comparisons.length > 0 ? { comparisons } : {}),
    keyTakeaway,
  };
}
```

- [ ] **Step 5: Run the tests again to confirm they pass**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs`
Expected: every `extraction —` / `fenced reply` / `missing title` / `items beyond` / `coreConcept beyond` / `zero usable items` / `unparseable text` / `prompts exist` line prints `ok`. (The `deleteInfographicModalCopy` import at the top will be unused until Task 3 adds its test back in — remove that import for now if `tsc`/lint complains, or leave it for Task 3; either is fine since this file isn't type-checked by `tsc -b`.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/textUtils.ts src/lib/infographicPrompt.ts tools/test-infographic.mjs
git commit -m "infographic: replace block generation with an extraction-call parser"
```

---

### Task 3: Design call — prompt, HTML extraction, and DOM-based sanitizing

**Files:**
- Modify: `package.json` (move `linkedom` from `devDependencies` to `dependencies`)
- Modify: `src/lib/infographicPrompt.ts` (append the design half)
- Modify: `tools/test-infographic.mjs` (append design/sanitizer tests)

**Interfaces:**
- Consumes: nothing by type — `INFOGRAPHIC_DESIGN_PROMPT` is a fixed string describing `ExtractedInfographicContent`'s shape (Task 2) in prose, for the model's benefit; no function in this task takes that type as a parameter.
- Produces: `INFOGRAPHIC_DESIGN_PROMPT: string`, `sanitizeInfographicHtml(html: string): string`, `parseDesignResponse(text: string): string | null`. Task 4 and Task 6 import these by these exact names.

**Decision already made (do not re-litigate):** the sanitizer parses the reply into a real DOM via `linkedom` and removes dangerous nodes/attributes structurally, rather than pattern-matching with regexes. This was a deliberate trade against added weight in the Netlify function's bundle — the security upside (robust against malformed/nested-tag bypasses a regex could miss) was chosen as worth that cost. `linkedom` is already a dependency of this repo (`tools/test-html.mjs` already uses it, as a devDependency) — Step 1 below promotes it to a runtime `dependency` since it now ships inside `src/lib/infographicPrompt.ts`, which the Netlify function imports directly.

Consequence worth internalizing before writing tests in Step 2: **`sanitizeInfographicHtml` is not byte-preserving, even on already-clean input.** Parsing and re-serializing through a real DOM can reformat whitespace/attribute quoting or insert an implied element (e.g. a missing `<head>`). Tests must assert on content survival and structure (`.includes(...)`, tag absence), never on exact string equality between input and output.

- [ ] **Step 1: Move `linkedom` into runtime dependencies**

In `package.json`, move the `"linkedom": "^0.18.13"` line from the `devDependencies` block to the `dependencies` block (keep the same version range). Run `npm install` afterward so the lockfile reflects the move.

- [ ] **Step 2: Write the failing tests for design-response parsing and sanitizing**

Append to `tools/test-infographic.mjs` (after the extraction tests from Task 2, before the `deleteInfographicModalCopy` tests at the bottom — add that import back to the top if it was removed in Task 2):

```js
import { parseDesignResponse, sanitizeInfographicHtml, INFOGRAPHIC_DESIGN_PROMPT } from '../src/lib/infographicPrompt.ts';

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

console.log('\ndesign — strips a meta-refresh and a base tag');
const withMetaBase =
  '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=https://evil.example">' +
  '<base href="https://evil.example/"></head><body><p>Content</p></body></html>';
const cleanedMetaBase = parseDesignResponse(withMetaBase);
check('meta-refresh is gone', cleanedMetaBase.toLowerCase().includes('refresh'), false);
check('base tag is gone', cleanedMetaBase.toLowerCase().includes('<base'), false);
check('surrounding content survives', cleanedMetaBase.includes('<p>Content</p>'), true);

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
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs`
Expected: FAIL — `parseDesignResponse`, `sanitizeInfographicHtml`, and `INFOGRAPHIC_DESIGN_PROMPT` don't exist yet.

- [ ] **Step 4: Append the design half to `src/lib/infographicPrompt.ts`**

Add to the end of the same file (after `parseExtractionResponse`):

```ts
import { parseHTML } from 'linkedom';

// ---------------------------------------------------------------------------
// Stage 2: design
// ---------------------------------------------------------------------------

/**
 * The design call's system prompt. Unlike extraction, this is not split by
 * detail level — it's the same layout/color/typography instructions
 * regardless of how much content it's handed; the extraction call already
 * did the level-scaling.
 *
 * The color tokens below are copied by hand from this app's src/index.css
 * (:root and :root[data-theme="dark"]) — see the Global Constraints note in
 * this feature's plan for why they can't be imported instead.
 */
export const INFOGRAPHIC_DESIGN_PROMPT = `Design an educational infographic as ONE self-contained HTML document with inline SVG diagrams, from the structured content you're given. The document must be static: no external images, no JavaScript of any kind — no <script>, no inline event-handler attributes (onclick, onload, etc.), no javascript: links. The ONLY external resource permitted is the Google Fonts <link> described under TYPE below; all other CSS must be inline in a <style> block. Set <html lang="..."> to the actual language of the content you were given — default to "en" only if that content is itself in English.

The user message is a JSON array holding exactly one object: the extracted content. Its fields:
- title: the infographic's title
- lede: a one-sentence framing line
- coreConcept (optional): 2-4 key/value pairs describing the single biggest idea, if there is one
- items: the main entries — each has a "label", a "detail" sentence, and an optional short "meta" tag
- comparisons (optional): pairs of { name, value } worth setting side by side
- keyTakeaway: the one sentence to leave the reader with

Use only what's in that object. Never invent facts, numbers, or examples beyond it.

LAYOUT — pick ONE pattern that matches the content's actual shape, and commit to it:
- If "items" reads as an ordered sequence or process → a horizontal or vertical chain/timeline diagram, boxes connected by SVG arrows.
- If "comparisons" is present, or "items" splits naturally into two groups being weighed against each other → side-by-side comparison cards, or a data table for more than a few rows.
- If "items" are parts of one whole → an "anatomy" diagram: one labeled structure broken into its fields, with pointer lines to each item.
- If "items" are a flat set of categories or facts with no inherent order → a hub-and-spoke diagram, or a clean grid of cards.
Do not default to generic hero-plus-cards if the content doesn't call for it.

COLOR — Use exactly these CSS variables on :root (this app's own palette, so the page matches it), and this exact dark override:

:root {
  --bg:#fafafa; --surface:#ffffff; --surface-raised:#f4f4f5;
  --border-soft:#e4e4e7; --border-strong:#d4d4d8;
  --text-primary:#18181b; --text-secondary:#71717a; --text-faint:#a1a1aa;
  --accent:#5b52d6; --accent-soft:rgba(91,82,214,0.08); --accent-contrast:#ffffff;
  --success:#1a8f5e; --success-soft:rgba(26,143,94,0.08);
  --warning:#b6650a; --warning-soft:rgba(182,101,10,0.08);
  --danger:#c0392b; --danger-soft:rgba(192,57,43,0.08);
  color-scheme: light;
}
:root[data-theme="dark"] {
  --bg:#0a0a0c; --surface:#18181b; --surface-raised:#212126;
  --border-soft:#2a2a30; --border-strong:#3f3f46;
  --text-primary:#f4f4f5; --text-secondary:#a1a1aa; --text-faint:#71717a;
  --accent:#8b87f0; --accent-soft:rgba(139,135,240,0.16); --accent-contrast:#0a0a0c;
  --success:#6bc79b; --success-soft:rgba(107,199,155,0.14);
  --warning:#e0a458; --warning-soft:rgba(224,164,88,0.14);
  --danger:#f2897c; --danger-soft:rgba(242,137,124,0.16);
  color-scheme: dark;
}

Copy those two blocks into the document verbatim (the app sets data-theme on the page itself; do not add a prefers-color-scheme media query, it would fight with that). Build every rule on top of var(--bg), var(--surface), var(--text-primary), etc. — never a hardcoded hex outside these two blocks. --accent is this app's one brand color; --success/--warning/--danger already carry the right hue for "good/caution/bad" semantics if the content needs them. Only if the content has some OTHER binary or ordinal property that doesn't map to good/caution/bad (e.g. two named categories, "before" vs "after") may you add ONE extra pair of your own hex values (a light one and a matching dark one) for that specific encoding — never more than one pair, and never in place of the tokens above.

TYPE — two Google Font families max, loaded via <link>, with real fallback stacks: one distinctive display/heading face with some personality (not Inter/Roboto/Arial — this app's own UI already uses Inter, so the infographic should read as a distinct designed page, not another app screen), one clean body face. Add a monospace face only for genuinely code-like or numeric-table tokens.

SVG — every diagram uses viewBox (never fixed pixel width/height) so it scales with its container. Give each <svg> diagram a <title> element naming what it shows, for screen readers. Keep captions under 25 words and body text under about 80 characters per line.

Before finalizing, check your own HTML/SVG for overlapping text, clipped labels, or elements that overflow their container, and for anything that would overflow at a narrow (400px) viewport width. Fix anything you find.

Reply with ONLY the finished HTML document — starting with <!DOCTYPE html> and ending with </html>. No explanation, no markdown code fence, nothing outside the document.`;

const REMOVABLE_SELECTOR =
  'script, iframe, object, embed, meta[http-equiv="refresh"], base, template';
const DANGEROUS_URI_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction']);
const DANGEROUS_URI_RE = /^(javascript|data):/i;

/**
 * Defense-in-depth, not the primary control — the primary control is that
 * this HTML is only ever rendered through a sandboxed iframe with no
 * allow-scripts (InfographicView.tsx), which cannot execute any of this
 * regardless. Parses the reply into a real DOM (linkedom — a pure-JS
 * implementation, so this stays safe to import into the Netlify function's
 * server bundle) and removes dangerous nodes/attributes structurally,
 * rather than pattern-matching strings, which a malformed or unusually
 * nested tag can evade.
 *
 * Not guaranteed to return its input unchanged even when the input was
 * already clean — see this plan's Global Constraints note on why tests
 * against this function assert on content survival, not byte equality.
 * The doctype is checked and restored explicitly, because losing it would
 * drop the rendered iframe into quirks mode.
 */
export function sanitizeInfographicHtml(html: string): string {
  const { document } = parseHTML(html);

  document.querySelectorAll(REMOVABLE_SELECTOR).forEach((el) => el.remove());

  document.querySelectorAll('*').forEach((el) => {
    // Array.from, not [...spread]: this file is compiled under BOTH
    // tsconfig.app.json and tsconfig.node.json (the Netlify function imports
    // it), and the node config's lib has no DOM.Iterable, so spreading a
    // NamedNodeMap fails to typecheck there. Array.from's ArrayLike overload
    // needs no Symbol.iterator.
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const isEventHandler = name.startsWith('on');
      // Strip ASCII whitespace and C0 controls before testing the scheme,
      // mirroring what a browser's URL parser does: `java&#9;script:alert(1)`
      // parses to a tab inside the scheme, which a leading-anchored \s* never
      // sees, but which the browser removes before resolving the URL.
      const normalized = attr.value.replace(/[ - ]/g, '');
      const isDangerousUri = DANGEROUS_URI_ATTRS.has(name) && DANGEROUS_URI_RE.test(normalized);
      if (isEventHandler || isDangerousUri) el.removeAttribute(attr.name);
    }
  });

  const serialized = document.toString();
  return /^\s*<!doctype html/i.test(serialized) ? serialized : `<!DOCTYPE html>${serialized}`;
}

/**
 * Slices the model's reply down to just the HTML document, tolerating a
 * markdown fence and prose either side of it, then sanitizes it.
 *
 * Returns null when no document is found at all — a reply that is pure
 * prose (a refusal, an apology) has nothing to render.
 */
export function parseDesignResponse(text: string): string | null {
  const cleaned = stripJsonFence(text);
  const lower = cleaned.toLowerCase();
  const doctypeIndex = lower.indexOf('<!doctype html');
  const htmlTagIndex = lower.indexOf('<html');
  const start = doctypeIndex !== -1 ? doctypeIndex : htmlTagIndex;
  const end = lower.lastIndexOf('</html>');
  if (start === -1 || end === -1 || end <= start) return null;

  const sliced = cleaned.slice(start, end + '</html>'.length);
  return sanitizeInfographicHtml(sliced);
}
```

- [ ] **Step 5: Run the tests again to confirm they pass**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs`
Expected: every line prints `ok`, including the pre-existing `deleteInfographicModalCopy` checks at the bottom of the file. If `linkedom`'s actual `querySelectorAll`/`attributes` API differs in some small way from what's written above (e.g. `el.attributes` not being spreadable), fix the implementation to match linkedom's real behavior rather than the test — the tests describe required outcomes, not implementation details.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/infographicPrompt.ts tools/test-infographic.mjs
git commit -m "infographic: add the design-call prompt and a DOM-based sanitizer"
```

---

### Task 4: Transport wiring — task names, token ceilings, and exports

**Files:**
- Modify: `src/lib/aiTransport.ts`
- Modify: `src/server/generateHandler.ts`

**Interfaces:**
- Consumes: `INFOGRAPHIC_EXTRACT_PROMPTS`, `INFOGRAPHIC_DESIGN_PROMPT` (Tasks 2-3).
- Produces: `AiTask` including `'infographic-extract-basic' | 'infographic-extract-standard' | 'infographic-extract-detailed' | 'infographic-design'`, and an **exported** `MAX_TOKENS` in both files (previously private to each). Task 5's parity test and Task 6 (generator) depend on these exact names.

- [ ] **Step 1: Update `src/lib/aiTransport.ts`**

Change the import:

```ts
import { INFOGRAPHIC_SYSTEM_PROMPTS } from './infographicPrompt';
```

to:

```ts
import { INFOGRAPHIC_EXTRACT_PROMPTS, INFOGRAPHIC_DESIGN_PROMPT } from './infographicPrompt';
```

Change the `AiTask` union's three `infographic-*` members:

```ts
  | 'infographic-basic'
  | 'infographic-standard'
  | 'infographic-detailed';
```

to:

```ts
  | 'infographic-extract-basic'
  | 'infographic-extract-standard'
  | 'infographic-extract-detailed'
  | 'infographic-design';
```

Change the matching three `PROMPTS` entries:

```ts
  'infographic-basic': INFOGRAPHIC_SYSTEM_PROMPTS.basic,
  'infographic-standard': INFOGRAPHIC_SYSTEM_PROMPTS.standard,
  'infographic-detailed': INFOGRAPHIC_SYSTEM_PROMPTS.detailed,
```

to:

```ts
  'infographic-extract-basic': INFOGRAPHIC_EXTRACT_PROMPTS.basic,
  'infographic-extract-standard': INFOGRAPHIC_EXTRACT_PROMPTS.standard,
  'infographic-extract-detailed': INFOGRAPHIC_EXTRACT_PROMPTS.detailed,
  'infographic-design': INFOGRAPHIC_DESIGN_PROMPT,
```

Change the `MAX_TOKENS` declaration itself from `const` to `export const` (Task 5's parity test imports it):

```ts
const MAX_TOKENS: Record<AiTask, number> = {
```

to:

```ts
export const MAX_TOKENS: Record<AiTask, number> = {
```

Change the matching `infographic-*` entries inside it:

```ts
  'infographic-basic': 4000,
  // Raised from 4000: a table or compare block's nested arrays cost more
  // JSON per block than a bullets section did, and Standard can now carry
  // up to 6 of them. Detailed stays at 8000 — its total-block ceiling (10)
  // is lower than the old sections ceiling (14) it replaced, which offsets
  // the added per-block verbosity.
  'infographic-standard': 6000,
  'infographic-detailed': 8000,
```

to:

```ts
  // The extraction reply is a small JSON object (a title, a handful of
  // short items) — these ceilings are generous relative to what a real
  // reply needs, "close to free" the same way this file's other ceilings
  // are (see the comment above this table).
  'infographic-extract-basic': 2000,
  'infographic-extract-standard': 3000,
  'infographic-extract-detailed': 4000,
  // A full self-contained HTML document (inline CSS, inline SVG diagrams)
  // runs far longer than a JSON reply ever did — this stays flat across
  // detail levels rather than scaling with the extraction ceilings above,
  // since layout/CSS boilerplate dominates the length more than item count
  // does.
  'infographic-design': 16000,
```

- [ ] **Step 2: Update `src/server/generateHandler.ts` to match**

Change the import the same way:

```ts
import { INFOGRAPHIC_SYSTEM_PROMPTS } from '../lib/infographicPrompt';
```

to:

```ts
import { INFOGRAPHIC_EXTRACT_PROMPTS, INFOGRAPHIC_DESIGN_PROMPT } from '../lib/infographicPrompt';
```

Change the `MAX_TOKENS` declaration from `const` to `export const`:

```ts
const MAX_TOKENS: Record<string, number> = {
```

to:

```ts
export const MAX_TOKENS: Record<string, number> = {
```

Change the record's three `infographic-*` entries to the same four entries and same values as Step 1 above (`'infographic-extract-basic': 2000`, `'infographic-extract-standard': 3000`, `'infographic-extract-detailed': 4000`, `'infographic-design': 16000`).

Change the `PROMPTS` map's three `infographic-*` entries:

```ts
  ['infographic-basic', INFOGRAPHIC_SYSTEM_PROMPTS.basic],
  ['infographic-standard', INFOGRAPHIC_SYSTEM_PROMPTS.standard],
  ['infographic-detailed', INFOGRAPHIC_SYSTEM_PROMPTS.detailed],
```

to:

```ts
  ['infographic-extract-basic', INFOGRAPHIC_EXTRACT_PROMPTS.basic],
  ['infographic-extract-standard', INFOGRAPHIC_EXTRACT_PROMPTS.standard],
  ['infographic-extract-detailed', INFOGRAPHIC_EXTRACT_PROMPTS.detailed],
  ['infographic-design', INFOGRAPHIC_DESIGN_PROMPT],
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: No errors in `src/lib/aiTransport.ts` or `src/server/generateHandler.ts`. Errors remain in `src/lib/infographicGenerator.ts`, `src/db/db.ts`, `src/components/infographic/blocks.tsx`, `src/components/infographic/icons.tsx`, `src/components/infographic/InfographicView.tsx`, `src/components/infographic/InfographicList.tsx` — fixed in later tasks.

- [ ] **Step 4: Commit**

```bash
git add src/lib/aiTransport.ts src/server/generateHandler.ts
git commit -m "infographic: rename tasks to extract/design, export MAX_TOKENS"
```

---

### Task 5: Parity tests — MAX_TOKENS and color tokens stay in sync

**Files:**
- Modify: `tools/test-infographic.mjs` (append)

**Interfaces:**
- Consumes: `MAX_TOKENS` (exported by Task 4 from both `src/lib/aiTransport.ts` and `src/server/generateHandler.ts`), `INFOGRAPHIC_DESIGN_PROMPT` (Task 3).

**Why this task exists:** the plan's Global Constraints name two pieces of data that must be hand-kept in sync — `MAX_TOKENS` between client/server, and the color-token block between `src/index.css` and the design prompt. Both are correct as of Tasks 3-4, but nothing catches future drift except a person re-reading this plan. This task adds that check.

- [ ] **Step 1: Backfill coverage that Tasks 2-3 left open**

Two earlier reviews flagged real code paths shipping without regression coverage. Since this task is already appending to the same test file, backfill them here.

First, from Task 3's fix round: `<template>` removal and `action`/`formaction` URI stripping were fixed in code and verified by hand, but nothing pins them. Append to `tools/test-infographic.mjs`:

```js
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
```

Second, from Task 2's review: `validateComparison` and `COMPARISONS_CEILING = 6` have zero coverage — the extraction tests only exercise `items` and `coreConcept`. Append:

```js
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
```

- [ ] **Step 2: Add a `MAX_TOKENS` parity check**

Append to `tools/test-infographic.mjs`:

```js
import { MAX_TOKENS as CLIENT_TOKENS } from '../src/lib/aiTransport.ts';
import { MAX_TOKENS as SERVER_TOKENS } from '../src/server/generateHandler.ts';

console.log('\nMAX_TOKENS stays in step between client and server');
for (const key of ['infographic-extract-basic', 'infographic-extract-standard', 'infographic-extract-detailed', 'infographic-design']) {
  check(`${key} matches`, CLIENT_TOKENS[key], SERVER_TOKENS[key]);
}
```

- [ ] **Step 3: Add a color-token parity check**

This can't diff two objects directly — one side is CSS text, the other a prompt string. Extract each named token's value from `src/index.css` by name (not a blanket sweep of every hex/rgba substring in the file — `--shadow-deep`, `--shadow-modal`, and `--scrim` also live inside the same `:root` blocks and are deliberately NOT part of the design prompt, since they're this app's own UI chrome, not infographic content). Compare against the design prompt with whitespace stripped from both sides, since `index.css` writes `rgba(91, 82, 214, 0.08)` (spaces after commas) while the design prompt (Task 3) writes `rgba(91,82,214,0.08)` (no spaces) — the values are meant to match, the formatting isn't.

Append:

```js
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
```

Note `INFOGRAPHIC_DESIGN_PROMPT` is already imported at the top of this file from Task 3 — do not add a second import for it.

- [ ] **Step 4: Run the full suite and confirm every new check passes**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs`
Expected: every line — including all 4 `MAX_TOKENS stays in step` lines and all `68` (17 tokens × 4 checks) color-token lines — prints `ok`.

- [ ] **Step 5: Commit**

```bash
git add tools/test-infographic.mjs
git commit -m "infographic: add parity tests for MAX_TOKENS and the color tokens"
```

---

### Task 6: Generator — two sequential calls, with stage reporting

**Files:**
- Modify: `src/lib/infographicGenerator.ts` (rewrite)

**Interfaces:**
- Consumes: `AiTask` (Task 4), `parseExtractionResponse`/`parseDesignResponse` (Tasks 2-3), `Infographic`/`InfographicDetail` (Task 1).
- Produces: `InfographicStage = 'extracting' | 'designing'` and `generateInfographic(deckId: string, deckName: string, cards: Flashcard[], detail: InfographicDetail, settings: AiSettings, signal?: AbortSignal, onStage?: (stage: InfographicStage) => void): Promise<Infographic>`. The signature gains two new **optional, trailing** parameters (`signal` already existed; `onStage` is new) — existing call sites that pass neither still compile. Task 7 (`InfographicMode.tsx`) is the one caller and is updated in this same pass of the plan to pass both.

- [ ] **Step 1: Rewrite the file**

```ts
import type { AiSettings } from './aiGenerator';
import type { AiTask } from './aiTransport';
import { callModel } from './aiTransport';
import { parseDesignResponse, parseExtractionResponse } from './infographicPrompt';
import type { Flashcard, Infographic, InfographicDetail } from '../types';

/** Which AiTask a given detail level's extraction call uses. The design call has no per-level variant. */
const EXTRACT_TASK_BY_DETAIL: Record<InfographicDetail, AiTask> = {
  basic: 'infographic-extract-basic',
  standard: 'infographic-extract-standard',
  detailed: 'infographic-extract-detailed',
};

/** Per-field character caps on what a card sends. Keeps "All cards" on a large,
 * document-built deck well clear of the server's MAX_REQUEST_CHARS (120,000,
 * see generateHandler.ts) — the same reasoning quizGenerator.ts's own trimCard
 * already applies to this app's other multi-card payloads. */
const MAX_FIELD_CHARS = 400;

/** Collapses a field to one line and cuts it to `max`, matching quizGenerator.ts's truncate. */
function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

/** Which of the two model calls is in flight — read by InfographicMode.tsx's generating screen. */
export type InfographicStage = 'extracting' | 'designing';

/**
 * Turns a chosen set of a deck's cards into one saved-shaped Infographic,
 * through two sequential model calls: extraction (cards in, structured
 * content out), then design (that content in, a self-contained HTML
 * document out). `onStage` fires once before each call, so a caller can
 * show what's actually happening rather than one static "generating" line
 * for the whole run.
 *
 * Neither call is batched or retried — the target outputs (a small JSON
 * object, then one HTML page) never approach a size that needs splitting
 * across requests. The *input* to the first call can still be large on a
 * big deck, which is what MAX_FIELD_CHARS guards against.
 *
 * Does not write anything to storage itself; the caller (InfographicMode)
 * calls saveInfographic with the result, keeping "generate" and "persist"
 * as separate steps the way the rest of the app already does.
 */
export async function generateInfographic(
  deckId: string,
  deckName: string,
  cards: Flashcard[],
  detail: InfographicDetail,
  settings: AiSettings,
  signal?: AbortSignal,
  onStage?: (stage: InfographicStage) => void
): Promise<Infographic> {
  const cardsPayload = cards.map((card) => ({
    front: truncate(card.front, MAX_FIELD_CHARS),
    back: truncate(card.back, MAX_FIELD_CHARS),
    context: card.context ? truncate(card.context, MAX_FIELD_CHARS) : card.context,
  }));

  onStage?.('extracting');
  const extractReply = await callModel(EXTRACT_TASK_BY_DETAIL[detail], cardsPayload, settings, signal);
  if (extractReply.stopReason === 'max_tokens') {
    throw new Error('The reply was cut off before it finished — try Basic or Standard, or choose fewer cards.');
  }
  const extracted = parseExtractionResponse(extractReply.text, deckName, detail);
  if (!extracted) {
    throw new Error("The infographic's content could not be read from the model's reply.");
  }

  // The design call's payload is one JSON object, not an array of cards —
  // it still has to travel as a single-element array, since callModel's
  // hosted route requires a non-empty array payload (see generateHandler.ts).
  onStage?.('designing');
  const designReply = await callModel('infographic-design', [extracted], settings, signal);
  if (designReply.stopReason === 'max_tokens') {
    throw new Error('The generated page was cut off before it finished — try Basic or Standard, or choose fewer cards.');
  }
  const html = parseDesignResponse(designReply.text);
  if (!html) {
    throw new Error("The infographic's page could not be read from the model's reply.");
  }

  return {
    id: crypto.randomUUID(),
    deckId,
    title: extracted.title,
    detail,
    html,
    cardIds: cards.map((card) => card.id),
    createdAt: Date.now(),
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: No errors in `src/lib/infographicGenerator.ts`. Errors remain in `src/db/db.ts`, `src/components/infographic/blocks.tsx`, `src/components/infographic/icons.tsx`, `src/components/infographic/InfographicView.tsx`, `src/components/infographic/InfographicList.tsx`, and now also `src/components/InfographicMode.tsx` will show a stale-but-still-compiling call (it passes fewer args than the new signature allows, which is legal — no error expected there yet; Task 7 updates it to actually use the new parameters).

- [ ] **Step 3: Commit**

```bash
git add src/lib/infographicGenerator.ts
git commit -m "infographic: generate through two sequential calls, reporting the active stage"
```

---

### Task 7: InfographicMode — real cancellation and stage feedback

**Files:**
- Modify: `src/components/InfographicMode.tsx`

**Interfaces:**
- Consumes: `InfographicStage`, `generateInfographic` (Task 6, now taking `signal` and `onStage`).

**Why this task exists:** the shipped feature's `handleGenerate` (`src/components/InfographicMode.tsx:68-87`) never passed a `signal` to `generateInfographic` even though that parameter already existed, and the "generating" phase rendered one static line for the whole run. That was tolerable when generation was a single JSON-producing call; it changes now that generation is two calls, the second of which (`infographic-design`, 16000 max tokens — this app's single largest ceiling) produces a full styled document rather than compact JSON, so the wait is longer and has two distinct stages. This mirrors the existing pattern in `src/components/quiz/useDeckQuiz.ts` (`AbortController` + a `Stop` button + progress text that names what's happening) at the scale this feature actually needs — a single abort flag and a two-value stage enum, not a full batch-progress system, since there's nothing to count here (two discrete calls, not N batches).

- [ ] **Step 1: Add the abort/stage state**

Change the import line:

```tsx
import { useEffect, useState } from "react";
```

to:

```tsx
import { useEffect, useRef, useState } from "react";
```

Add an import for the new type, alongside the existing `generateInfographic` import:

```tsx
import { generateInfographic } from "../lib/infographicGenerator";
```

to:

```tsx
import { generateInfographic } from "../lib/infographicGenerator";
import type { InfographicStage } from "../lib/infographicGenerator";
```

Add two new pieces of state/ref alongside the existing ones (near `const [ai, setAi] = useState<AiSettings>(() => loadAiSettings());`):

```tsx
  const [stage, setStage] = useState<InfographicStage | null>(null);
  const abortRef = useRef<AbortController | null>(null);
```

- [ ] **Step 2: Wire the controller through `handleGenerate`, and add `stopGenerating`**

Replace:

```tsx
  const handleGenerate = async (detail: InfographicDetail, chosenCards: Flashcard[]) => {
    setPhase("generating");
    try {
      const infographic = await generateInfographic(deckId, deck!.name, chosenCards, detail, ai);
      await saveInfographic(infographic);
      await refreshList();
      setViewing(infographic);
      setPhase("view");
    } catch (err) {
      console.error("[infographic] Could not generate the infographic:", err);
      // The thrown error's own message names the actual cause (no API key,
      // the dev server not running, a reply cut off mid-JSON, the payload
      // too large) — discarding it in favour of one generic line left every
      // failure mode looking identical and equally unactionable.
      setGenerationError(
        `The infographic could not be generated. ${err instanceof Error ? err.message : ""}`.trim()
      );
      setPhase("error");
    }
  };
```

with:

```tsx
  const handleGenerate = async (detail: InfographicDetail, chosenCards: Flashcard[]) => {
    setPhase("generating");
    setStage(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const infographic = await generateInfographic(
        deckId,
        deck!.name,
        chosenCards,
        detail,
        ai,
        controller.signal,
        setStage
      );
      await saveInfographic(infographic);
      await refreshList();
      setViewing(infographic);
      setPhase("view");
    } catch (err) {
      // Stopping is a choice, not a failure — the same distinction
      // useDeckQuiz.ts's own abort handling makes. Nothing partial is kept
      // here (unlike quiz's per-batch saves): both calls in
      // generateInfographic are cheap enough, and neither produces
      // anything worth persisting on its own, that redoing the whole run
      // on the next attempt is the right cost, not a shortcut being
      // skipped.
      if (controller.signal.aborted) {
        setPhase("setup");
        return;
      }
      console.error("[infographic] Could not generate the infographic:", err);
      // The thrown error's own message names the actual cause (no API key,
      // the dev server not running, a reply cut off mid-JSON, the payload
      // too large) — discarding it in favour of one generic line left every
      // failure mode looking identical and equally unactionable.
      setGenerationError(
        `The infographic could not be generated. ${err instanceof Error ? err.message : ""}`.trim()
      );
      setPhase("error");
    } finally {
      abortRef.current = null;
    }
  };

  const stopGenerating = () => abortRef.current?.abort();
```

- [ ] **Step 3: Show the stage and a Stop button on the generating screen**

Replace:

```tsx
  if (phase === "generating") {
    return (
      <div className="infographic-generating">
        <span className="chalk-spinner" aria-hidden="true" />
        <p className="muted small">Writing the infographic…</p>
      </div>
    );
  }
```

with:

```tsx
  if (phase === "generating") {
    return (
      <div className="infographic-generating">
        <span className="chalk-spinner" aria-hidden="true" />
        <p className="muted small">
          {stage === "designing" ? "Designing the page…" : "Reading the cards…"}
        </p>
        <div className="form-actions">
          <button type="button" className="ghost-btn" onClick={stopGenerating}>
            Stop
          </button>
        </div>
      </div>
    );
  }
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b`
Expected: No errors in `src/components/InfographicMode.tsx`. Errors remain only in `src/db/db.ts`, `src/components/infographic/blocks.tsx`, `src/components/infographic/icons.tsx`, `src/components/infographic/InfographicView.tsx`, `src/components/infographic/InfographicList.tsx`.

- [ ] **Step 5: Manual check**

Run: `npm run dev`. Start a Detailed generation and confirm the stage text changes from "Reading the cards…" to "Designing the page…" partway through. Start another generation and press Stop partway through — confirm it returns to the Setup screen cleanly, with no error banner and no console-logged error.

- [ ] **Step 6: Commit**

```bash
git add src/components/InfographicMode.tsx
git commit -m "infographic: add real cancellation and stage feedback to generation"
```

---

### Task 8: Storage safety net

**Files:**
- Modify: `src/db/db.ts:541-555`

**Interfaces:**
- Consumes: `Infographic` (Task 1).
- Produces: no change to `getInfographicsForDeck`'s signature — same cleanup behavior, checking the new field.

- [ ] **Step 1: Update the validity check**

In `getInfographicsForDeck` (`src/db/db.ts:545-552`), change:

```ts
  for (const infographic of infographics) {
    if (Array.isArray((infographic as Infographic).blocks)) {
      valid.push(infographic);
    } else {
```

to:

```ts
  for (const infographic of infographics) {
    if (typeof (infographic as Infographic).html === 'string' && (infographic as Infographic).html.length > 0) {
      valid.push(infographic);
    } else {
```

Update the function's docstring (`src/db/db.ts:533-540`) to describe the new shape instead of `blocks`:

```ts
/**
 * Every infographic saved for a deck, newest first.
 *
 * Also the one place a straggler from before this shape existed would turn
 * up — nothing has ever written one, so this is a safety net, not a
 * migration: a row with no usable `html` string is deleted on the spot
 * rather than handed to a screen that expects one.
 */
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: No errors in `src/db/db.ts`. Errors remain only in `src/components/infographic/blocks.tsx`, `src/components/infographic/icons.tsx`, `src/components/infographic/InfographicView.tsx`, `src/components/infographic/InfographicList.tsx`.

- [ ] **Step 3: Commit**

```bash
git add src/db/db.ts
git commit -m "infographic: clean up old block-shaped rows instead of the old blocks check"
```

---

### Task 9: View screen — sandboxed iframe rendering

**Files:**
- Modify: `src/components/infographic/InfographicView.tsx` (rewrite)
- Delete: `src/components/infographic/blocks.tsx`
- Delete: `src/components/infographic/icons.tsx`

**Interfaces:**
- Consumes: `Infographic` (Task 1, with `html: string`), `currentTheme` (`src/lib/theme.ts`, already exists — returns `'light' | 'dark'`), `deleteInfographicModalCopy` (`src/lib/infographicCopy.ts`, unchanged), `Modal` (`src/components/ui/Modal.tsx`, unchanged).
- Produces: same `Props` shape (`infographic`, `totalCardCount`, `onBack`, `onDelete`) — `InfographicMode.tsx` calls this component unchanged.

- [ ] **Step 1: Delete the two files this screen no longer uses**

```bash
git rm src/components/infographic/blocks.tsx src/components/infographic/icons.tsx
```

- [ ] **Step 2: Rewrite `InfographicView.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import type { Infographic } from "../../types";
import { deleteInfographicModalCopy } from "../../lib/infographicCopy";
import { currentTheme } from "../../lib/theme";
import Modal from "../ui/Modal";

interface Props {
  infographic: Infographic;
  totalCardCount: number;
  onBack: () => void;
  onDelete: () => void;
}

const DETAIL_LABEL: Record<Infographic["detail"], string> = {
  basic: "Basic",
  standard: "Standard",
  detailed: "Detailed",
};

/**
 * One saved infographic: the model's own self-contained HTML/SVG document,
 * shown through a sandboxed iframe rather than through this app's own DOM.
 *
 * `sandbox="allow-same-origin"` with no `allow-scripts` is the point: no
 * script the model wrote — a <script> tag, an inline handler, anything
 * inside an SVG — can execute, in this frame or anywhere else. `allow-same-
 * origin` alone is what lets *this* component (running unsandboxed, in the
 * app's own document) still reach into the frame's DOM below to read its
 * height and to mirror the app's current theme onto it; it grants the frame
 * no privilege it could act on, since nothing inside it can run at all.
 * Never dangerouslySetInnerHTML.
 */
export default function InfographicView({ infographic, totalCardCount, onBack, onDelete }: Props) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const copy = deleteInfographicModalCopy(infographic.title);
  const usedAllCards = infographic.cardIds.length === totalCardCount;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    let resizeObserver: ResizeObserver | null = null;
    let themeObserver: MutationObserver | null = null;

    const applyTheme = () => {
      iframe.contentDocument?.documentElement.setAttribute("data-theme", currentTheme());
    };

    const syncFrame = () => {
      const root = iframe.contentDocument?.documentElement;
      if (!root) return;

      applyTheme();
      iframe.style.height = `${root.scrollHeight}px`;

      // Fonts loading async, or the content reflowing at a new width, can
      // change the document's height after this first measurement — this
      // keeps the iframe's own height in step with it for as long as it's
      // mounted, rather than only once on load.
      resizeObserver = new ResizeObserver(() => {
        iframe.style.height = `${root.scrollHeight}px`;
      });
      resizeObserver.observe(root);

      // The app's theme toggle (ThemeToggle.tsx) sets data-theme on the
      // main document with no event of its own to listen for — this is
      // what keeps an already-open infographic in step with it, rather
      // than only picking up the app's theme once, at load.
      themeObserver = new MutationObserver(applyTheme);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    };

    iframe.addEventListener("load", syncFrame);
    return () => {
      iframe.removeEventListener("load", syncFrame);
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
    };
  }, [infographic.html]);

  return (
    <div>
      <p className="deck-eyebrow infographic-view-meta">
        {DETAIL_LABEL[infographic.detail]} ·{" "}
        {usedAllCards ? `all ${totalCardCount} cards` : `${infographic.cardIds.length} cards`}
      </p>

      <div className="infographic-frame-wrap">
        <iframe
          ref={iframeRef}
          className="infographic-frame"
          title={infographic.title}
          srcDoc={infographic.html}
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
        />
      </div>

      <div className="view-actions">
        <button type="button" className="ghost-btn" onClick={onBack}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 6l-6 6 6 6" />
          </svg>
          Back to infographics
        </button>
        <button type="button" className="ghost-btn" onClick={() => setConfirmingDelete(true)} style={{ color: "var(--danger)" }}>
          Delete this infographic
        </button>
      </div>

      <Modal open={confirmingDelete} onClose={() => setConfirmingDelete(false)} labelledBy="delete-infographic-title" danger>
        <div className="dialog-head">
          <div className="dialog-title-row">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 7c4.5 8 8 8 8.5 8s3-6 7.5-8" />
            </svg>
            <h2 id="delete-infographic-title">{copy.title}</h2>
          </div>
          <button type="button" className="icon-btn" title="Cancel" aria-label="Cancel" onClick={() => setConfirmingDelete(false)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <p className="body-text">{copy.body}</p>
        <div className="dialog-actions">
          <button type="button" className="ghost-btn" onClick={() => setConfirmingDelete(false)}>
            Cancel
          </button>
          <button type="button" className="btn-danger-solid" onClick={onDelete}>
            Delete infographic
          </button>
        </div>
      </Modal>
    </div>
  );
}
```

Note there is no `<h2>{infographic.title}</h2>` in this app-chrome anymore — the generated document already builds its own title into the page (see the design prompt), so repeating it above the iframe would show it twice. The eyebrow line (detail level + card count) is the only app-chrome text kept.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: No errors in `src/components/infographic/InfographicView.tsx`. Errors remain only in `src/components/infographic/InfographicList.tsx`.

- [ ] **Step 4: Commit**

```bash
git add -A src/components/infographic
git commit -m "infographic: render the design call's HTML through a sandboxed iframe"
```

---

### Task 10: List screen — drop the block count

**Files:**
- Modify: `src/components/infographic/InfographicList.tsx:37-41`

**Interfaces:**
- Consumes: `Infographic` (Task 1) — no more `blocks` field to read a count from.

- [ ] **Step 1: Remove the "N sections" clause from the meta line**

Change:

```tsx
          <p className="meta">
            {infographic.blocks.length} section{infographic.blocks.length === 1 ? "" : "s"} ·{" "}
            {infographic.cardIds.length} card{infographic.cardIds.length === 1 ? "" : "s"} ·{" "}
            {new Date(infographic.createdAt).toLocaleDateString()}
          </p>
```

to:

```tsx
          <p className="meta">
            {infographic.cardIds.length} card{infographic.cardIds.length === 1 ? "" : "s"} ·{" "}
            {new Date(infographic.createdAt).toLocaleDateString()}
          </p>
```

- [ ] **Step 2: Typecheck the whole project**

Run: `npx tsc -b`
Expected: no errors anywhere.

- [ ] **Step 3: Commit**

```bash
git add src/components/infographic/InfographicList.tsx
git commit -m "infographic: drop the block count from the list screen's meta line"
```

---

### Task 11: Setup screen — describe items, not blocks

**Files:**
- Modify: `src/components/infographic/InfographicSetup.tsx:15-19`

**Why this task exists:** `DETAIL_OPTIONS`'s copy currently names the exact `InfographicBlock` concept Task 1 deletes ("a couple of blocks, a few points each"). Once this ships there is no such thing as a block anywhere the user can see — the shipped feature never surfaced that word in its UI either, so this brings the copy in line with what actually generates now: a target item count (`ITEM_TARGET` in Task 2 — basic 4-5, standard 6-8, detailed 8-10 items), laid out by a model making its own layout choice rather than rendered as a fixed number of card components.

- [ ] **Step 1: Rewrite the three `blurb` strings**

Change:

```ts
const DETAIL_OPTIONS: { id: InfographicDetail; name: string; blurb: string; pageEstimate: string }[] = [
  { id: "basic", name: "Basic", blurb: "The core ideas only — a couple of blocks, a few points each.", pageEstimate: "~1 page" },
  { id: "standard", name: "Standard", blurb: "A fuller pass — most of the deck's key ideas, grouped and explained.", pageEstimate: "~1-2 pages" },
  { id: "detailed", name: "Detailed", blurb: "Thorough coverage across the deck, for a deeper study reference.", pageEstimate: "~3 pages" },
];
```

to:

```ts
const DETAIL_OPTIONS: { id: InfographicDetail; name: string; blurb: string; pageEstimate: string }[] = [
  { id: "basic", name: "Basic", blurb: "The core ideas only — 4-5 key points.", pageEstimate: "~1 page" },
  { id: "standard", name: "Standard", blurb: "A fuller pass — 6-8 of the deck's key ideas, explained.", pageEstimate: "~1-2 pages" },
  { id: "detailed", name: "Detailed", blurb: "Thorough coverage — 8-10 points, for a deeper study reference.", pageEstimate: "~3 pages" },
];
```

The `pageEstimate` strings are left as they were — they were a rough guess even under the old block-rendering output, and now depend on which layout the design call picks for a given item count (a hub-and-spoke of 8 items and a data table of 8 rows read as different lengths). Task 13's end-to-end check asks you to eyeball real output against these estimates and adjust here if they're now clearly off; don't guess at new numbers without having generated a real page first.

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/infographic/InfographicSetup.tsx
git commit -m "infographic: describe detail levels by item count, not block count"
```

---

### Task 12: Styles — swap block CSS for the iframe frame

**Files:**
- Modify: `src/index.css:2308-2652`

**Interfaces:**
- Produces: `.infographic-view-meta`, `.infographic-frame-wrap`, `.infographic-frame` — the three classes Task 9's `InfographicView.tsx` renders. `.view-actions` (already used by that file) and `.infographic-generating`/`.form-actions` (already used by Task 7's generating screen) are kept as-is.

- [ ] **Step 1: Two design-prompt clauses the View screen's review asked for**

Task 9's review surfaced two gaps that belong in `INFOGRAPHIC_DESIGN_PROMPT` (`src/lib/infographicPrompt.ts`), not in CSS. Make these as their own commit, separate from the stylesheet work below.

First, viewport-relative heights fight the iframe's height-syncing. `InfographicView` measures the frame's `scrollHeight` and writes it back as the iframe's height; a document using `100vh` derives its own viewport from that height, so the two can chase each other for a few reflow cycles before settling. A content-sized poster has no reason to use `vh` anyway. Second, the deleted block renderers used to *guarantee* semantic markup — real `<table>` with `<caption>` and `<th scope="col">`, `<ol>` for ordered steps, ARIA labels on stat callouts. Nothing guarantees that now; the model is the only author of its own semantics, so the prompt has to ask.

In the `SVG —` paragraph, after the existing `<title>` sentence, and as a new paragraph after it, add:

```
SEMANTICS — the page's accessibility comes entirely from the markup you write, so use real elements: a genuine <table> with a <caption> and <th scope="col"> for tabular data, <ol> for anything ordered, <ul> for unordered lists, and headings in a sensible order. Never fake a table with divs.

SIZING — size the page to its content. Never use viewport-relative units (vh, vw, svh, dvh) for heights or min-heights: this document is displayed inside a frame that is resized to fit it, so viewport units and that resizing work against each other.
```

Then run `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs` — still 115 passing, since the color-token blocks are untouched — and commit:

```bash
git add src/lib/infographicPrompt.ts
git commit -m "infographic: ask the design call for semantic markup and content sizing"
```

- [ ] **Step 2: Remove the block-rendering CSS, keep `.view-actions`**

Delete every rule from `/* ---------- Infographic: View ---------- */` (`src/index.css:2308`) through the `.page-break::before, .page-break::after` rule (`src/index.css:2638-2643`) — that's `.infographic-doc`, `.infographic-doc-header`, `.infographic-sections`, `.infographic-section` and its icon/body/callout/stat/quote/timeline/table/compare/steps variants, the `@media (max-width: 520px)` and `@media print` blocks tied to them, and `.page-break`. Keep the `.view-actions` rule (`src/index.css:2645-2652`) exactly as it is — Task 9's rewrite still uses that class.

- [ ] **Step 3: Add the iframe frame's styles in their place**

Where that block used to be (right before `.view-actions`), add:

```css
/* ---------- Infographic: View ---------- */

.infographic-view-meta {
  text-align: center;
  margin: 0 0 0.75rem;
}

.infographic-frame-wrap {
  max-width: 900px;
  margin: 0 auto;
  border: 1px solid var(--border-soft);
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface);
}

.infographic-frame {
  display: block;
  width: 100%;
  border: none;
}
```

- [ ] **Step 4: Manual check**

Run: `npm run dev`, open a deck's infographic list screen. Confirm no visual regression on the List/Setup screens (their CSS is untouched) and no dangling references to the removed selectors:

Run: `grep -rn "infographic-doc\|infographic-section\|page-break" src --include="*.tsx"`
Expected: no results (both consuming components were already rewritten in Tasks 9-10).

Also confirm the generating screen (Task 7) still looks reasonable with its new Stop button — `.infographic-generating`'s flex-column layout should center the button under the existing spinner/text without any CSS change, but eyeball it once.

- [ ] **Step 5: Commit**

```bash
git add src/index.css
git commit -m "infographic: replace block-card styles with the iframe frame's styles"
```

---

### Task 13: Full build and end-to-end manual verification

**Files:** none (verification only).

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 2: Run the full pure-function test suite**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs`
Expected: every check prints `ok`, `failures` stays 0.

- [ ] **Step 3: End-to-end check against the dev server**

Run: `npm run dev`, then in the browser: open a deck that has cards (or add a key under AI Settings if running with no hosted backend), choose "Create infographic," generate at each of Basic/Standard/Detailed, and for one of them:
- Confirm the page renders inside the frame (not a blank iframe, not visible raw HTML text).
- Toggle the app's light/dark switch (`ThemeToggle`) and confirm the infographic's colors switch with it, both while it's open and freshly on load.
- Resize the browser window and confirm the iframe's height adjusts rather than clipping or leaving dead space.
- Open the browser's dev tools, inspect the iframe element, and confirm its `sandbox` attribute reads exactly `allow-same-origin` (no `allow-scripts`).
- Still in dev tools, check the Network tab for the Google Fonts request the generated page makes and confirm it actually succeeds (200, not blocked/failed) — a blocked or slow font load fails silently, the page just renders in a fallback font, so nothing else in this checklist would catch it.
- Confirm a Detailed generation shows "Reading the cards…" then "Designing the page…", and that pressing Stop partway through returns cleanly to Setup with no error banner (Task 7).
- From the list screen, delete the infographic and confirm the `Modal` confirmation (not a browser `confirm()`) appears, and that deleting removes just that one row.
- Eyeball each of the three generated pages against `InfographicSetup.tsx`'s `pageEstimate` copy (Task 11) and update that copy if it's now clearly off for a given level.

This is a manual check because, as with the shipped feature's own IndexedDB/browser-only behavior, there is no headless-browser runner in this repo to automate it.

- [ ] **Step 4: Hosted-mode latency — advisory, only if this deployment actually uses hosted mode**

`infographic-design` is this app's single largest `MAX_TOKENS` ceiling (16000, tied with `cards`/`vignette`/`ocr`), spent on a full styled document rather than compact JSON — the kind of output that plausibly runs long enough to matter. `netlify.toml` in this repo sets no `[functions]` timeout override today, so a hosted deployment runs at Netlify's platform default (documented as 60 seconds for synchronous functions at the time this plan was written) — half of this app's own client-side `REQUEST_TIMEOUT_MS` (120 seconds, `src/lib/aiTransport.ts`). If the design call alone ever runs close to or past the platform's limit in a real hosted deployment, Netlify kills the function before the client's own timeout would ever fire, and the failure surfaces as a generic network/502 error with no `stopReason` to distinguish it from any other failure.

This step is **advisory, not something to change blindly**: it requires an actual deployed hosted environment to measure against, which this plan's other steps do not assume exists. If you have one:
- Time a few real `infographic-design` calls at Detailed, on a full deck, in hosted mode specifically (BYOK never touches this limit — it calls Anthropic directly from the browser).
- If the real p95 is anywhere near the platform's limit, either raise the function's own timeout (confirm the actual ceiling available on this deployment's plan tier before relying on a specific number — it varies by plan) or lower `infographic-design`'s `MAX_TOKENS` to a value comfortably clear of the measured latency, accepting shorter pages as the trade-off. Either is a legitimate call; treat "neither checked, on a deployment that actually serves hosted-mode traffic" as the thing to avoid, not a specific fix to apply.

- [ ] **Step 5: No further commit** — this task is verification of Tasks 1-12's already-committed work, not new changes. If any check fails, return to the task that owns the broken behavior, fix it there, and re-run this task's checks.
