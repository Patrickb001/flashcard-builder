# Flashcard Infographic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a deck's flashcards be turned into a Claude-generated infographic — a title plus icon-and-bullet sections — at one of three detail levels (Basic/Standard/Detailed), from all cards or a chosen subset. A deck can hold any number of saved infographics, listed on their own screen, reachable from a new "Create infographic" button in Deck Manager.

**Architecture:** Follows this app's existing AI-task pattern exactly (the same shape `cards`/`quiz`/`vignette`/`ocr` already use): a new `'infographic'` task with its own system prompt and response parser (`src/lib/infographicPrompt.ts`), wired into the existing hosted/BYOK transport (`src/lib/aiTransport.ts`, `src/server/generateHandler.ts`) and a thin orchestrator (`src/lib/infographicGenerator.ts`). Storage is a new `infographics` IndexedDB store shaped like `flashcards`/`testQuestions` (own `id`, `by-deckId` index — a deck can have many). The screen is a new route, `/deck/:id/infographic`, owned by one phase-driven component (`InfographicMode`, mirroring `TestMode`) with four phases: **List** (saved infographics) → **Setup** (detail level + card scope) → **Generating** → **View**.

**Tech Stack:** TypeScript, React 18, React Router 7, `idb` over IndexedDB, the existing Claude Sonnet 5 integration (hosted serverless function or bring-your-own-key). Pure logic (`parseInfographicResponse`) is tested with Node 22 (`--experimental-strip-types`), matching every other `src/lib/*.ts` module; the IndexedDB and UI additions are checked manually against the running dev server, the same way `tools/idb-check.html` already documents for browser-only behavior this repo has no headless-browser runner to automate.

**Spec:** `docs/superpowers/specs/2026-09-13-flashcard-infographic-design.md`

**Task order note:** Tasks 1→2→3 are pure/storage/transport, in that order, since each only depends on the previous (Task 3's generator imports Task 1's prompt/parser and calls `callModel`; nothing in 1–3 touches React). Tasks 4, 5 and 6 (Setup, List, View) are independent of each other and of 1–3 except for the shared types from Task 1 — each defines its own props and can be built and reviewed in any order relative to its siblings. Task 7 (routing, `InfographicMode`, the Deck Manager button) is last: it imports Tasks 1–6's exports to wire the whole feature together and is where the flow becomes end-to-end testable.

## Global Constraints

- Exact values from the spec (do not re-derive or "improve" these):
  - `InfographicIcon` union: `'book' | 'lightbulb' | 'brain' | 'chart' | 'list' | 'arrows' | 'target' | 'clock' | 'check' | 'warning' | 'network' | 'question'`
  - `InfographicDetail` union: `'basic' | 'standard' | 'detailed'`
  - Per-level target/clamp table:
    | Level | Target sections | Target points/section | Clamp ceiling (sections) | Clamp ceiling (points/section) |
    |---|---|---|---|---|
    | `basic` | 3–4 | 2–3 | 5 | 4 |
    | `standard` | 5–7 | 3–4 | 8 | 5 |
    | `detailed` | 8–12 | 3–5 | 14 | 6 |
  - `MAX_TOKENS.infographic = 4000` (both `src/lib/aiTransport.ts` and `src/server/generateHandler.ts` — these two copies must stay in step, per that file's own existing rule).
  - `DB_VERSION` goes from `3` to `4`.
  - New IndexedDB store: `infographics`, `keyPath: 'id'`, index `by-deckId` on `'deckId'`.
  - Delete confirmation text: `` `Delete "${title}"? This can't be undone.` ``.
- No `?folder=` or history-based navigation tricks in this feature — Setup/List/View are phases of one mounted component at one URL, not separate routes, so moving between them is plain component state, never `navigate()`. Only entering (`/deck/:id` → `/deck/:id/infographic`) and leaving (`onExit` → `/`) are real navigations.
- The model never writes HTML/CSS/markup and the app never renders any with `dangerouslySetInnerHTML` or an iframe — only the structured JSON shape in the Data Model below.
- Match each file's existing quote style: `src/types.ts`, `src/db/db.ts`, and every new `src/lib/*.ts` file use single quotes (matching `deckFolders.ts`, `quizPrompt.ts`, `aiTransport.ts`). `src/components/InfographicMode.tsx`, everything under `src/components/infographic/`, and `src/routes/InfographicRoute.tsx` use double quotes (matching `DeckManager.tsx`, `StudyMode.tsx`, `TestMode.tsx`, and the `components/quiz/` sibling directory). `src/routes/router.tsx` keeps its existing single-quote style for the one line added to it.
- No new `dependencies` or `devDependencies`.
- Commit messages: a sentence-case description, no `feat:` prefix, ending with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- Work happens on the current branch, `CreateInfoGraphic`, already checked out for this feature.

---

### Task 1: Types, prompt, and response parser

**Files:**
- Modify: `src/types.ts`
- Create: `src/lib/infographicPrompt.ts`
- Create: `tools/test-infographic.mjs`

**Interfaces:**
- Consumes: nothing new (only existing `Flashcard` shape, read-only, for the payload shape described in the prompt — this task does not build the payload itself, see Task 3).
- Produces (all from `src/types.ts` unless noted):
  - `InfographicIcon`, `InfographicDetail`, `InfographicSection { heading: string; icon: InfographicIcon; points: string[] }`, `Infographic { id: string; deckId: string; title: string; detail: InfographicDetail; sections: InfographicSection[]; cardIds: string[]; createdAt: number }`, `LlmInfographic { title: string; sections: InfographicSection[] }`.
  - `src/lib/infographicPrompt.ts`: `INFOGRAPHIC_SYSTEM_PROMPT: string`, `parseInfographicResponse(text: string, deckName: string, detail: InfographicDetail): LlmInfographic | null`.
  - Task 3 imports `INFOGRAPHIC_SYSTEM_PROMPT` and `parseInfographicResponse` from `../lib/infographicPrompt`; Task 7 imports the five type exports from `../types`.

- [ ] **Step 1: Add the types**

In `src/types.ts`, add after the existing `Folder` interface (which currently ends the folder-related block, right before `/** Which kind of document a deck was built from. */`):

```ts
/**
 * The icons an infographic section can carry. Fixed on purpose: the app can
 * only render icons it ships its own SVG for, so the model is given exactly
 * this list in the prompt and never asked to invent a name.
 */
export type InfographicIcon =
  | 'book'
  | 'lightbulb'
  | 'brain'
  | 'chart'
  | 'list'
  | 'arrows'
  | 'target'
  | 'clock'
  | 'check'
  | 'warning'
  | 'network'
  | 'question';

/**
 * How much content to ask for. A prompt-shaping choice, not a stored render
 * setting the view screen reads — but it's kept on the record because the
 * infographics list shows it.
 */
export type InfographicDetail = 'basic' | 'standard' | 'detailed';

export interface InfographicSection {
  heading: string;
  icon: InfographicIcon;
  points: string[];
}

/**
 * One saved infographic. A deck can have any number of these — different
 * detail levels or card subsets are different infographics, not versions of
 * one, so there is no "the deck's infographic" singular and no overwrite.
 */
export interface Infographic {
  id: string;
  deckId: string;
  title: string;
  detail: InfographicDetail;
  sections: InfographicSection[];
  /** Which cards this one was built from, for the list screen's "N cards" line. */
  cardIds: string[];
  createdAt: number;
}

/**
 * What the model's response actually contains — title and sections only.
 * `Infographic` adds `id`, `deckId`, `detail`, `cardIds` and `createdAt`,
 * none of which are in the model's own reply. Same split `LlmCard`
 * (cardPrompt.ts) already keeps from the stored `Flashcard`.
 */
export interface LlmInfographic {
  title: string;
  sections: InfographicSection[];
}
```

- [ ] **Step 2: Write the failing test**

Create `tools/test-infographic.mjs`:

```js
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
  sections: Array.from({ length: 8 }, (_, i) => ({
    heading: `Section ${i + 1}`,
    icon: 'list',
    points: ['One point.'],
  })),
});
{
  const result = parseInfographicResponse(tooManySections, 'Big Deck', 'basic');
  check('basic (ceiling 5) keeps only the first 5 of 8 sections', result.sections.length, 5);
  check('kept sections are the first ones, in order', result.sections[0].heading, 'Section 1');
}
{
  const result = parseInfographicResponse(tooManySections, 'Big Deck', 'detailed');
  check('detailed (ceiling 14) keeps all 8 sections unclamped', result.sections.length, 8);
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
  const result = parseInfographicResponse(tooManyPoints, 'Verbose Deck', 'detailed');
  check('detailed (ceiling 6 points) keeps 6 of 7', result.sections[0].points, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
}

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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs`
Expected: fails to even run — `src/lib/infographicPrompt.ts` does not exist yet (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 4: Write the prompt and parser**

Create `src/lib/infographicPrompt.ts`:

```ts
import { stripJsonFence } from './textUtils';
import type { InfographicDetail, InfographicIcon, LlmInfographic } from '../types';

/**
 * Turns a deck's flashcards into one infographic — a title plus a handful of
 * icon-and-bullet sections. Shared between the browser (bring-your-own-key
 * mode) and the serverless function, exactly as the card and quiz prompts
 * are. This module must import nothing at runtime beyond other such
 * modules — the Netlify function imports it, and a stray reference to the
 * DOM or to localStorage would follow it into the server bundle.
 */

const ICONS: InfographicIcon[] = [
  'book',
  'lightbulb',
  'brain',
  'chart',
  'list',
  'arrows',
  'target',
  'clock',
  'check',
  'warning',
  'network',
  'question',
];

/** Target section/point counts per level — the prompt states these as guidance, never a hard cap. */
const TARGETS: Record<InfographicDetail, { sections: string; points: string }> = {
  basic: { sections: '3-4', points: '2-3' },
  standard: { sections: '5-7', points: '3-4' },
  detailed: { sections: '8-12', points: '3-5' },
};

/** Clamp ceilings per level — enforced by the parser below, never told to the model. */
const CEILINGS: Record<InfographicDetail, { sections: number; points: number }> = {
  basic: { sections: 5, points: 4 },
  standard: { sections: 8, points: 5 },
  detailed: { sections: 14, points: 6 },
};

export const INFOGRAPHIC_SYSTEM_PROMPT = `You turn a student's flashcards into a single-page-style infographic they can use to review the material at a glance.

You are given some flashcards from one deck (front, back, and sometimes a topic) and a target level of detail: Basic, Standard, or Detailed. Each level has a rough target for how many sections and how many points per section to write — aim for that range, but it is a guide, not a hard limit; write what the material actually supports.

Reply with ONLY a JSON object, no prose before or after, shaped exactly like this:

{
  "title": "A short title for the whole infographic",
  "sections": [
    { "heading": "A short section heading", "icon": "one of the icon names below", "points": ["A short point.", "Another short point."] }
  ]
}

Rules:517
1. SYNTHESIZE, DON'T TRANSCRIBE — a point should read as a distilled idea, not a card's back pasted in verbatim. Group related cards into one section rather than writing one section per card.
2. icon MUST be exactly one of: ${ICONS.join(', ')}. Pick whichever reads best for that section's topic; never invent a name outside this list.
3. Keep headings and points short — this is read at a glance, not studied line by line.
4. Every section needs at least one point and a heading; never return an empty sections array.`;

/**
 * Reads the model's reply as one JSON object, tolerating a markdown fence,
 * then clamps its sections/points to the given level's ceiling. Clamps
 * rather than rejects, so a reply that ran a little long or a little short
 * of its target is still stored rather than thrown away.
 *
 * Returns null only when nothing usable could be read at all: the reply
 * isn't a JSON object, or it parses but has zero sections.
 */
export function parseInfographicResponse(
  text: string,
  deckName: string,
  detail: InfographicDetail
): LlmInfographic | null {
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

  const raw = parsed as { title?: unknown; sections?: unknown };
  if (!Array.isArray(raw.sections)) return null;

  const ceiling = CEILINGS[detail];
  const sections = raw.sections
    .filter(
      (item): item is { heading: string; icon: string; points: string[] } =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as { heading?: unknown }).heading === 'string' &&
        Array.isArray((item as { points?: unknown }).points) &&
        (item as { points: unknown[] }).points.every((p) => typeof p === 'string')
    )
    .slice(0, ceiling.sections)
    .map((section) => ({
      heading: section.heading.trim(),
      icon: (ICONS as string[]).includes(section.icon) ? (section.icon as InfographicIcon) : ('list' as const),
      points: section.points.slice(0, ceiling.points).map((p) => p.trim()),
    }));

  if (sections.length === 0) return null;

  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : deckName;

  return { title, sections };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs`
Expected: every line prints `ok`, then `All passed.`, exit code 0.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors. This is a separate, necessary check from Step 5: `--experimental-strip-types` *erases* types to run the file, it does not check them, so a real type error (for instance in the `Array.isArray(raw.sections)` narrowing this file relies on) could pass Step 5 at runtime while still failing an actual build.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/lib/infographicPrompt.ts tools/test-infographic.mjs
git commit -m "$(cat <<'EOF'
Add infographic types, prompt, and response parser with per-level clamping

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Storage

**Files:**
- Modify: `src/db/db.ts`

**Interfaces:**
- Consumes: `Infographic` from `../types` (Task 1).
- Produces: `getInfographicsForDeck(deckId: string): Promise<Infographic[]>`, `saveInfographic(infographic: Infographic): Promise<void>`, `deleteInfographic(id: string): Promise<void>`. Task 3's `generateInfographic` does not call any of these (per the spec, it only builds and returns an `Infographic`); Task 7's `InfographicMode` calls all three.

- [ ] **Step 1: Read the current schema and `deleteDeck` before changing them**

Open `src/db/db.ts`. Find:
- The `FlashcardForgeDB` schema interface (near the top, listing `decks`, `flashcards`, `testQuestions`, `folders`).
- `DB_VERSION` (currently `3`) and the `upgrade` callback's `if (oldVersion < N)` blocks.
- `deleteDeck` (around line 266), whose transaction currently covers `['decks', 'flashcards', 'testQuestions']` and loops `for (const store of ['flashcards', 'testQuestions'] as const)` deleting by the `by-deckId` index cursor.

- [ ] **Step 2: Add the schema entry and bump the version**

In the `FlashcardForgeDB` schema interface, add (matching the existing `flashcards`/`testQuestions` entries' shape):

```ts
  infographics: {
    key: string;
    value: Infographic;
    indexes: { 'by-deckId': string };
  };
```

Add `Infographic` to the existing `import type { ... } from '../types';` line at the top of the file.

Change `const DB_VERSION = 3;` to `const DB_VERSION = 4;`.

In the `upgrade` callback, after the existing `if (oldVersion < 3)` block (the one creating `folders`), add:

```ts
        if (oldVersion < 4) {
          const infographicStore = db.createObjectStore('infographics', { keyPath: 'id' });
          infographicStore.createIndex('by-deckId', 'deckId');
        }
```

Do not change the `oldVersion < 1/2/3` blocks.

- [ ] **Step 3: Add the three functions**

Add near the other per-store function groups (e.g. after the folders functions, or wherever a new `// ---------------------------------------------------------------------------\n// Infographics\n// ---------------------------------------------------------------------------` section reads cleanly):

```ts
// ---------------------------------------------------------------------------
// Infographics
// ---------------------------------------------------------------------------

/** Every infographic saved for a deck, newest first. */
export async function getInfographicsForDeck(deckId: string): Promise<Infographic[]> {
  const db = await getDB();
  const infographics = await db.getAllFromIndex('infographics', 'by-deckId', deckId);
  return infographics.sort((a, b) => b.createdAt - a.createdAt);
}

/** Stores one infographic. Always a new row — infographics are never overwritten by id. */
export async function saveInfographic(infographic: Infographic): Promise<void> {
  const db = await getDB();
  await db.put('infographics', infographic);
}

/** Removes one infographic. Does not touch the deck or any of its other infographics. */
export async function deleteInfographic(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('infographics', id);
}
```

- [ ] **Step 4: Extend `deleteDeck`'s cleanup**

In `deleteDeck`, add `'infographics'` to the transaction's store list and to the cursor-loop array:

```ts
export async function deleteDeck(deckId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['decks', 'flashcards', 'testQuestions', 'infographics'], 'readwrite');
  await tx.objectStore('decks').delete(deckId);

  for (const store of ['flashcards', 'testQuestions', 'infographics'] as const) {
    const index = tx.objectStore(store).index('by-deckId');
    let cursor = await index.openCursor(IDBKeyRange.only(deckId));
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
  }

  await tx.done;
}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 6: Verify against the running app**

There is no automated harness for IndexedDB in this repo (no headless-browser runner) — verify manually, the way `tools/idb-check.html` documents for this kind of change:

```bash
npm run dev -- --port 5173 &
for i in $(seq 1 30); do curl -sf http://localhost:5173 >/dev/null && echo UP && break; sleep 1; done
```

With a real browser (or a scripted one via Playwright, imported directly from its npx cache path if `chromium-cli` isn't installed — check first), against a deck you seed directly into IndexedDB (matching the shape other manual checks in this codebase's history have used):

1. Open the app once so the v4 upgrade runs (check `indexedDB.databases()` or just that no console error appears).
2. In the console, write two `Infographic` rows for the same `deckId` (different `id`s) via `saveInfographic`, then confirm `getInfographicsForDeck(deckId)` returns both, newest first.
3. Call `deleteInfographic` on one of them; confirm `getInfographicsForDeck` now returns only the other.
4. Seed a deck with one card and one infographic, then call `deleteDeck` on it; confirm the deck, its card, and its infographic are all gone (check `getInfographicsForDeck` returns `[]` afterward).

- [ ] **Step 7: Commit**

```bash
git add src/db/db.ts
git commit -m "$(cat <<'EOF'
Add the infographics IndexedDB store (DB_VERSION 3->4) and its CRUD functions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: AI transport, server, and generator

**Files:**
- Modify: `src/lib/aiTransport.ts`
- Modify: `src/server/generateHandler.ts`
- Create: `src/lib/infographicGenerator.ts`

**Interfaces:**
- Consumes: `INFOGRAPHIC_SYSTEM_PROMPT`, `parseInfographicResponse` from `../lib/infographicPrompt` (Task 1); `callModel` from `./aiTransport` (existing); `AiSettings` from `./aiGenerator` (existing); `Flashcard`, `Infographic`, `InfographicDetail` from `../types` (Task 1 for the last two).
- Produces: `generateInfographic(deckId: string, deckName: string, cards: Flashcard[], detail: InfographicDetail, settings: AiSettings, signal?: AbortSignal): Promise<Infographic>`. Task 7's `InfographicMode` calls this and then calls Task 2's `saveInfographic` on the result.

- [ ] **Step 1: Read `AiTask`, `PROMPTS`, and `MAX_TOKENS` in `aiTransport.ts` before changing them**

Open `src/lib/aiTransport.ts`. Find `export type AiTask = 'cards' | 'quiz' | 'vignette' | 'vignette-audit' | 'ocr';`, the `PROMPTS` record below it, and the `MAX_TOKENS` record below that.

- [ ] **Step 2: Add the task to `aiTransport.ts`**

```ts
export type AiTask = 'cards' | 'quiz' | 'vignette' | 'vignette-audit' | 'ocr' | 'infographic';
```

Add the import at the top, alongside the other prompt imports:

```ts
import { INFOGRAPHIC_SYSTEM_PROMPT } from './infographicPrompt';
```

In `PROMPTS`:

```ts
const PROMPTS: Record<AiTask, string> = {
  cards: CARD_SYSTEM_PROMPT,
  quiz: QUIZ_SYSTEM_PROMPT,
  vignette: VIGNETTE_SYSTEM_PROMPT,
  'vignette-audit': VIGNETTE_AUDIT_SYSTEM_PROMPT,
  ocr: OCR_SYSTEM_PROMPT,
  infographic: INFOGRAPHIC_SYSTEM_PROMPT,
};
```

In `MAX_TOKENS`:

```ts
const MAX_TOKENS: Record<AiTask, number> = {
  cards: 16000,
  quiz: 8000,
  vignette: 16000,
  'vignette-audit': 1000,
  ocr: 16000,
  infographic: 4000,
};
```

- [ ] **Step 3: Add the same task to `generateHandler.ts`**

Open `src/server/generateHandler.ts`. Add the import:

```ts
import { INFOGRAPHIC_SYSTEM_PROMPT } from '../lib/infographicPrompt';
```

In its own `MAX_TOKENS` (a `Record<string, number>`, separate from but must match `aiTransport.ts`'s):

```ts
const MAX_TOKENS: Record<string, number> = {
  cards: 16000,
  quiz: 8000,
  vignette: 16000,
  'vignette-audit': 1000,
  ocr: 16000,
  infographic: 4000,
};
```

In its `PROMPTS` map:

```ts
const PROMPTS = new Map<string, string>([
  ['cards', CARD_SYSTEM_PROMPT],
  ['quiz', QUIZ_SYSTEM_PROMPT],
  ['vignette', VIGNETTE_SYSTEM_PROMPT],
  ['vignette-audit', VIGNETTE_AUDIT_SYSTEM_PROMPT],
  ['ocr', OCR_SYSTEM_PROMPT],
  ['infographic', INFOGRAPHIC_SYSTEM_PROMPT],
]);
```

- [ ] **Step 4: Type-check the transport/server changes**

Run: `npx tsc --noEmit -p .`
Expected: no errors (this step alone should already pass, since Task 1 already created `infographicPrompt.ts`).

- [ ] **Step 5: Write the generator**

Create `src/lib/infographicGenerator.ts`:

```ts
import type { AiSettings } from './aiGenerator';
import { callModel } from './aiTransport';
import { parseInfographicResponse } from './infographicPrompt';
import type { Flashcard, Infographic, InfographicDetail } from '../types';

/**
 * Turns a chosen set of a deck's cards into one saved-shaped Infographic.
 *
 * A single request, unlike card drafting — there is no batching or retry
 * pass here, since the target output (a handful of sections) never
 * approaches a size that needs splitting across requests.
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
  signal?: AbortSignal
): Promise<Infographic> {
  const payload = cards.map((card) => ({
    front: card.front,
    back: card.back,
    context: card.context,
  }));

  const { text } = await callModel('infographic', payload, settings, signal);
  const parsed = parseInfographicResponse(text, deckName, detail);
  if (!parsed) {
    throw new Error('The infographic could not be read from the model\'s reply.');
  }

  return {
    id: crypto.randomUUID(),
    deckId,
    title: parsed.title,
    detail,
    sections: parsed.sections,
    cardIds: cards.map((card) => card.id),
    createdAt: Date.now(),
  };
}
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 7: Run the existing infographic parser test once more (regression check)**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs`
Expected: still `All passed.` — this task didn't change parsing logic, only where the prompt/parser are wired in, so this is a quick confirmation nothing broke.

- [ ] **Step 8: Commit**

```bash
git add src/lib/aiTransport.ts src/server/generateHandler.ts src/lib/infographicGenerator.ts
git commit -m "$(cat <<'EOF'
Wire the infographic task into AI transport, the server handler, and a generator

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Setup screen

**Files:**
- Create: `src/components/infographic/InfographicSetup.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: `Flashcard` from `../../types` (existing); `AiSettings` from `../../lib/aiGenerator` (existing); `AiSettingsPanel` from `../AiSettingsPanel` (existing, default export, props `{ settings: AiSettings; onChange: (s: AiSettings) => void }`); `InfographicDetail` from `../../types` (Task 1).
- Produces: `InfographicSetup`, default export, props:
  ```ts
  interface Props {
    deckName: string;
    cards: Flashcard[];
    ai: AiSettings;
    onAiChange: (settings: AiSettings) => void;
    onGenerate: (detail: InfographicDetail, chosenCards: Flashcard[]) => void;
    /** Present only when there's a saved-infographics list to return to (omitted for a deck's very first one). */
    onBack?: () => void;
  }
  ```
  Task 7's `InfographicMode` renders this during its `'setup'` phase.

- [ ] **Step 1: Write the component**

Create `src/components/infographic/InfographicSetup.tsx`:

```tsx
import { useState } from "react";
import type { AiSettings } from "../../lib/aiGenerator";
import type { Flashcard, InfographicDetail } from "../../types";
import AiSettingsPanel from "../AiSettingsPanel";

interface Props {
  deckName: string;
  cards: Flashcard[];
  ai: AiSettings;
  onAiChange: (settings: AiSettings) => void;
  onGenerate: (detail: InfographicDetail, chosenCards: Flashcard[]) => void;
  onBack?: () => void;
}

const DETAIL_OPTIONS: { id: InfographicDetail; name: string; blurb: string; pageEstimate: string }[] = [
  { id: "basic", name: "Basic", blurb: "The core ideas only — a handful of sections, a few points each.", pageEstimate: "~1 page" },
  { id: "standard", name: "Standard", blurb: "A fuller pass — most of the deck's key ideas, grouped and explained.", pageEstimate: "~2 pages" },
  { id: "detailed", name: "Detailed", blurb: "Thorough coverage across the deck, for a deeper study reference.", pageEstimate: "up to 5 pages" },
];

/**
 * Choosing how an infographic gets built: how much detail, and which cards.
 *
 * Mirrors QuizSetup's shape (a choice screen before a model call) but has no
 * "write missing questions" concept — an infographic is generated fresh
 * every time, never built up card-by-card.
 */
export default function InfographicSetup({
  deckName,
  cards,
  ai,
  onAiChange,
  onGenerate,
  onBack,
}: Props) {
  const [detail, setDetail] = useState<InfographicDetail>("standard");
  const [scope, setScope] = useState<"all" | "choose">("all");
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());

  const toggleCardSelected = (cardId: string) => {
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  };

  const chosenCards = scope === "all" ? cards : cards.filter((card) => selectedCardIds.has(card.id));
  const canGenerate = ai.mode !== "off" && chosenCards.length > 0;

  return (
    <div className="infographic-setup">
      {onBack && (
        <button type="button" className="ghost-btn small" onClick={onBack}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Back to your infographics
        </button>
      )}

      <p className="eyebrow">Infographic</p>
      <h2 className="infographic-setup-title">{deckName}</h2>

      <div className="field-group">
        <h3>How much detail?</h3>
        <div className="detail-options">
          {DETAIL_OPTIONS.map((option) => (
            <button
              type="button"
              key={option.id}
              className={`detail-card ${detail === option.id ? "active" : ""}`}
              onClick={() => setDetail(option.id)}
            >
              <h4>{option.name}</h4>
              <p>{option.blurb}</p>
              <span className="page-est">{option.pageEstimate}</span>
            </button>
          ))}
        </div>
        <p className="field-hint">
          A guide, not a hard limit — the model may return more or fewer sections depending on how much the
          deck actually covers.
        </p>
      </div>

      <div className="field-group">
        <h3>Which cards?</h3>
        <div className="segmented">
          <button type="button" className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>
            All cards
          </button>
          <button type="button" className={scope === "choose" ? "active" : ""} onClick={() => setScope("choose")}>
            Choose cards
          </button>
        </div>
        <p className="field-hint">
          {cards.length} card{cards.length === 1 ? "" : "s"} in this deck.
        </p>

        {scope === "choose" && (
          <ul className="add-decks-list">
            {cards.map((card) => (
              <li key={card.id} className="add-decks-row">
                <label>
                  <input
                    type="checkbox"
                    checked={selectedCardIds.has(card.id)}
                    onChange={() => toggleCardSelected(card.id)}
                  />
                  <span>{card.front}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {ai.mode === "off" && <AiSettingsPanel settings={ai} onChange={onAiChange} />}

      <div className="form-actions">
        <button
          type="button"
          className="primary-btn"
          disabled={!canGenerate}
          onClick={() => onGenerate(detail, chosenCards)}
        >
          Generate infographic
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the CSS**

Append to `src/index.css`:

```css
/* ---------- Infographic: Setup ---------- */

.infographic-setup {
  max-width: 640px;
  margin: 0 auto;
}

.infographic-setup-title {
  font-size: 1.4rem;
  margin: 0 0 1.5rem;
}

.infographic-setup .field-group {
  margin-bottom: 1.5rem;
}

.infographic-setup .field-group h3 {
  font-size: 0.86rem;
  margin: 0 0 0.6rem;
  color: var(--text-primary);
}

.infographic-setup .field-hint {
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin: 0.3rem 0 0;
}

.detail-options {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.75rem;
}

.detail-card {
  font-family: var(--font-ui);
  text-align: left;
  border: 1.5px solid var(--border-soft);
  border-radius: 10px;
  padding: 0.9rem 1rem;
  cursor: pointer;
  background: var(--surface);
}

.detail-card.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.detail-card h4 {
  margin: 0 0 0.25rem;
  font-size: 0.92rem;
}

.detail-card p {
  margin: 0;
  font-size: 0.78rem;
  color: var(--text-secondary);
  line-height: 1.45;
}

.detail-card .page-est {
  display: inline-block;
  margin-top: 0.5rem;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--accent);
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 100px;
  padding: 0.15rem 0.55rem;
}

.infographic-setup .segmented {
  display: inline-flex;
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  padding: 0.2rem;
  gap: 0.2rem;
}

.infographic-setup .segmented button {
  font-family: var(--font-ui);
  font-weight: 600;
  font-size: 0.86rem;
  cursor: pointer;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 7px;
  padding: 0.55rem 1rem;
}

.infographic-setup .segmented button.active {
  background: var(--surface-raised);
  color: var(--text-primary);
  border-color: var(--border-strong);
}

@media (max-width: 620px) {
  .detail-options {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

No route renders this component yet — that's Task 7, whose end-to-end check (Step 8 there) is where its actual on-screen behavior (detail cards toggling, the checklist appearing, Generate's disabled state) gets verified against the running app. Step 3's type-check is this task's own gate.

- [ ] **Step 4: Commit**

```bash
git add src/components/infographic/InfographicSetup.tsx src/index.css
git commit -m "$(cat <<'EOF'
Add the infographic Setup screen (detail level + card scope)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Infographics list screen

**Files:**
- Create: `src/components/infographic/InfographicList.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: `Infographic` from `../../types` (Task 1).
- Produces: `InfographicList`, default export, props:
  ```ts
  interface Props {
    infographics: Infographic[];
    onView: (infographic: Infographic) => void;
    onDelete: (id: string) => void;
    onCreate: () => void;
  }
  ```
  Task 7's `InfographicMode` renders this during its `'list'` phase.

- [ ] **Step 1: Write the component**

Create `src/components/infographic/InfographicList.tsx`:

```tsx
import type { Infographic } from "../../types";

interface Props {
  infographics: Infographic[];
  onView: (infographic: Infographic) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
}

const DETAIL_LABEL: Record<Infographic["detail"], string> = {
  basic: "Basic",
  standard: "Standard",
  detailed: "Detailed",
};

/** Every infographic saved for a deck, plus a tile to start another one. */
export default function InfographicList({ infographics, onView, onDelete, onCreate }: Props) {
  const handleDelete = (infographic: Infographic) => {
    if (confirm(`Delete "${infographic.title}"? This can't be undone.`)) {
      onDelete(infographic.id);
    }
  };

  return (
    <div className="infographic-grid">
      {infographics.map((infographic) => (
        <div key={infographic.id} className="infographic-card">
          <div className="infographic-card-top">
            <span className="detail-tag">{DETAIL_LABEL[infographic.detail]}</span>
          </div>
          <h4>{infographic.title}</h4>
          <p className="meta">
            {infographic.sections.length} section{infographic.sections.length === 1 ? "" : "s"} ·{" "}
            {infographic.cardIds.length} card{infographic.cardIds.length === 1 ? "" : "s"} ·{" "}
            {new Date(infographic.createdAt).toLocaleDateString()}
          </p>
          <div className="infographic-card-actions">
            <button type="button" className="btn-view" onClick={() => onView(infographic)}>
              View
            </button>
            <button type="button" className="btn-delete" onClick={() => handleDelete(infographic)}>
              Delete
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="new-infographic-card" onClick={onCreate}>
        + Create infographic
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Add the CSS**

Append to `src/index.css`:

```css
/* ---------- Infographic: List ---------- */

.infographic-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 1rem;
}

.infographic-card {
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  padding: 1rem 1.1rem;
  background: var(--surface);
}

.infographic-card-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 0.6rem;
}

.detail-tag {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-radius: 100px;
  padding: 0.15rem 0.55rem;
  border: 1px solid var(--accent);
  color: var(--accent);
}

.infographic-card h4 {
  margin: 0 0 0.3rem;
  font-size: 1rem;
}

.infographic-card .meta {
  font-size: 0.78rem;
  color: var(--text-secondary);
  margin: 0 0 0.9rem;
}

.infographic-card-actions {
  display: flex;
  gap: 0.5rem;
}

.infographic-card-actions button {
  font-family: var(--font-ui);
  font-weight: 600;
  font-size: 0.82rem;
  border-radius: 7px;
  padding: 0.45rem 0.75rem;
  cursor: pointer;
  border: 1px solid transparent;
}

.btn-view {
  background: var(--accent);
  color: var(--accent-contrast);
}

.btn-delete {
  background: transparent;
  color: var(--danger);
}

.btn-delete:hover {
  background: var(--danger-soft);
}

.new-infographic-card {
  font-family: var(--font-ui);
  border: 1.5px dashed var(--border-strong);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 0.9rem;
  cursor: pointer;
  min-height: 118px;
  background: transparent;
}

.new-infographic-card:hover {
  border-color: var(--accent);
  color: var(--accent);
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

No route renders this component yet — that's Task 7, whose end-to-end check (Step 8 there) is where its actual on-screen behavior (each card's detail tag/meta line, the delete confirmation, the dashed "+ Create" tile) gets verified against the running app. Step 3's type-check is this task's own gate.

- [ ] **Step 4: Commit**

```bash
git add src/components/infographic/InfographicList.tsx src/index.css
git commit -m "$(cat <<'EOF'
Add the infographics list screen

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Icons and View screen

**Files:**
- Create: `src/components/infographic/icons.tsx`
- Create: `src/components/infographic/InfographicView.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: `InfographicIcon`, `Infographic` from `../../types` (Task 1).
- Produces:
  - `src/components/infographic/icons.tsx`: `INFOGRAPHIC_ICONS: Record<InfographicIcon, ReactNode>` (default export not needed — a named export, since this is a lookup table, not a component).
  - `InfographicView`, default export, props:
    ```ts
    interface Props {
      infographic: Infographic;
      totalCardCount: number;
      onBack: () => void;
      onDelete: () => void;
    }
    ```
  Task 7's `InfographicMode` renders `InfographicView` during its `'view'` phase and imports nothing directly from `icons.tsx` (only `InfographicView` does).

- [ ] **Step 1: Write the icon set**

Create `src/components/infographic/icons.tsx`:

```tsx
import type { ReactNode } from "react";
import type { InfographicIcon } from "../../types";

/**
 * One small line icon per InfographicIcon value, in this app's existing icon
 * style: 24x24 viewBox, stroke="currentColor", 2px stroke, round caps/joins.
 * A fixed lookup rather than a component, since every icon this app can
 * render is enumerated here — there is never a value to fall back for once
 * parseInfographicResponse has already clamped an unrecognized name to
 * 'list'.
 */
export const INFOGRAPHIC_ICONS: Record<InfographicIcon, ReactNode> = {
  book: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H12v18H5.5A1.5 1.5 0 0 1 4 19.5z" />
      <path d="M12 3h6.5A1.5 1.5 0 0 1 20 4.5v15a1.5 1.5 0 0 1-1.5 1.5H12" />
    </svg>
  ),
  lightbulb: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21h6" />
      <path d="M10 17v-2.3a5 5 0 1 1 4 0V17z" />
    </svg>
  ),
  brain: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a4 4 0 0 0-4 4v1a3 3 0 0 0-2 5 3 3 0 0 0 2 3v1a4 4 0 0 0 8 0v-1a3 3 0 0 0 2-3 3 3 0 0 0-2-5V7a4 4 0 0 0-4-4z" />
    </svg>
  ),
  chart: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 20h18" />
      <path d="M7 20v-6M12 20V8M17 20v-10" />
    </svg>
  ),
  list: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  ),
  arrows: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12h16M4 12l4-4M4 12l4 4M20 12l-4-4M20 12l-4 4" />
    </svg>
  ),
  target: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  clock: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  ),
  check: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  warning: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 3.9 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  ),
  network: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M8.2 7.3 10 15M15.8 7.3 14 15M8.5 6h7" />
    </svg>
  ),
  question: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 9a3 3 0 1 1 4 2.8c-.6.3-1 1-1 1.7v.5" />
      <path d="M12 17h.01" />
    </svg>
  ),
};
```

- [ ] **Step 2: Write the View screen**

Create `src/components/infographic/InfographicView.tsx`:

```tsx
import type { Infographic } from "../../types";
import { INFOGRAPHIC_ICONS } from "./icons";

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
 * One saved infographic in full: title, then every section as an icon,
 * heading and its bullet points.
 *
 * The dashed page-break divider every 3 sections is presentational only —
 * see the spec's "Pagination is presentation, not data" note. Nothing about
 * where a section actually falls on a page is stored; this is purely a
 * visual cue that content of this length would run to more than one page.
 */
export default function InfographicView({ infographic, totalCardCount, onBack, onDelete }: Props) {
  const handleDelete = () => {
    if (confirm(`Delete "${infographic.title}"? This can't be undone.`)) {
      onDelete();
    }
  };

  const usedAllCards = infographic.cardIds.length === totalCardCount;

  return (
    <div>
      <div className="infographic-doc">
        <div className="infographic-doc-header">
          <p className="deck-eyebrow">
            {DETAIL_LABEL[infographic.detail]} ·{" "}
            {usedAllCards ? `all ${totalCardCount} cards` : `${infographic.cardIds.length} cards`}
          </p>
          <h2>{infographic.title}</h2>
        </div>

        <div className="infographic-sections">
          {infographic.sections.map((section, index) => (
            <div key={index}>
              {index > 0 && index % 3 === 0 && (
                <div className="page-break">Page {Math.floor(index / 3) + 1}</div>
              )}
              <div className="infographic-section">
                <div className="infographic-section-icon">{INFOGRAPHIC_ICONS[section.icon]}</div>
                <div className="infographic-section-body">
                  <h4>{section.heading}</h4>
                  <ul>
                    {section.points.map((point, i) => (
                      <li key={i}>{point}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="view-actions">
        <button type="button" className="ghost-btn" onClick={onBack}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 6l-6 6 6 6" />
          </svg>
          Back to infographics
        </button>
        <button type="button" className="ghost-btn" onClick={handleDelete} style={{ color: "var(--danger)" }}>
          Delete this infographic
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add the CSS**

Append to `src/index.css`:

```css
/* ---------- Infographic: View ---------- */

.infographic-doc {
  max-width: 640px;
  margin: 0 auto;
  background: var(--surface);
}

.infographic-doc-header {
  text-align: center;
  margin-bottom: 1.75rem;
}

.infographic-doc-header .deck-eyebrow {
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin: 0 0 0.3rem;
}

.infographic-doc-header h2 {
  font-size: 1.55rem;
  margin: 0;
}

.infographic-sections {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.infographic-section {
  border: 1px solid var(--border-soft);
  border-radius: 12px;
  padding: 1.1rem 1.25rem;
  display: flex;
  gap: 0.9rem;
}

.infographic-section-icon {
  flex: none;
  width: 38px;
  height: 38px;
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
}

.infographic-section-body h4 {
  margin: 0 0 0.5rem;
  font-size: 0.98rem;
}

.infographic-section-body ul {
  margin: 0;
  padding-left: 1.1rem;
  font-size: 0.86rem;
  color: var(--text-secondary);
  line-height: 1.55;
}

.infographic-section-body li + li {
  margin-top: 0.15rem;
}

.page-break {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  margin: 0.4rem 0;
  color: var(--text-faint);
  font-size: 0.72rem;
  font-weight: 600;
}

.page-break::before,
.page-break::after {
  content: "";
  flex: 1;
  border-top: 1px dashed var(--border-strong);
}

.view-actions {
  display: flex;
  justify-content: space-between;
  margin-top: 2rem;
  max-width: 640px;
  margin-left: auto;
  margin-right: auto;
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

No route renders this component yet — that's Task 7, whose end-to-end check (Step 8 there) is where its actual on-screen behavior (icons, the page-break divider on a longer infographic, the delete confirmation) gets verified against the running app. Step 4's type-check is this task's own gate.

- [ ] **Step 5: Commit**

```bash
git add src/components/infographic/icons.tsx src/components/infographic/InfographicView.tsx src/index.css
git commit -m "$(cat <<'EOF'
Add the infographic icon set and View screen

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Wire it together — InfographicMode, routing, and the Deck Manager button

**Files:**
- Create: `src/components/InfographicMode.tsx`
- Create: `src/routes/InfographicRoute.tsx`
- Modify: `src/routes/router.tsx`
- Modify: `src/routes/DeckRoute.tsx`
- Modify: `src/components/DeckManager.tsx`

**Interfaces:**
- Consumes: `InfographicSetup` (Task 4), `InfographicList` (Task 5), `InfographicView` (Task 6), `generateInfographic` (Task 3), `getInfographicsForDeck`/`saveInfographic`/`deleteInfographic` (Task 2), `Infographic`/`InfographicDetail` (Task 1), `useDeck` (existing), `DeckGate` (existing), `loadAiSettings` (existing, `src/lib/aiGenerator.ts`).
- Produces: nothing new for other files — this is the top of the feature's own tree. `DeckManager`'s new `onInfographic: (deckId: string) => void` prop is consumed only by `DeckRoute`.

- [ ] **Step 1: Write `InfographicMode`**

Create `src/components/InfographicMode.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { AiSettings } from "../lib/aiGenerator";
import { loadAiSettings } from "../lib/aiGenerator";
import { deleteInfographic, getInfographicsForDeck, saveInfographic } from "../db/db";
import { generateInfographic } from "../lib/infographicGenerator";
import type { Flashcard, Infographic, InfographicDetail } from "../types";
import { useDeck } from "./useDeck";
import DeckGate from "./ui/DeckGate";
import ErrorNotice from "./ui/ErrorNotice";
import InfographicList from "./infographic/InfographicList";
import InfographicSetup from "./infographic/InfographicSetup";
import InfographicView from "./infographic/InfographicView";

interface Props {
  deckId: string;
  onExit: () => void;
}

type Phase = "list" | "setup" | "generating" | "view" | "error";

/**
 * The infographic feature's phase owner, mirroring TestMode's role: this
 * component decides which screen is showing, the screens themselves are
 * dumb and just call back up.
 *
 * List/Setup/Generating/View/Error are all component state, not separate
 * routes — moving between them never calls navigate(), only the entry from
 * Deck Manager and the exit back to it are real navigations. See the spec's
 * note on why the top bar's history-based Back button can't help with
 * these in-component transitions.
 */
export default function InfographicMode({ deckId, onExit }: Props) {
  const { deck, cards, loading, error } = useDeck(deckId);
  const [infographics, setInfographics] = useState<Infographic[]>([]);
  const [infographicsLoaded, setInfographicsLoaded] = useState(false);
  const [phase, setPhase] = useState<Phase>("list");
  const [viewing, setViewing] = useState<Infographic | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [ai, setAi] = useState<AiSettings>(() => loadAiSettings());

  useEffect(() => {
    let cancelled = false;
    getInfographicsForDeck(deckId).then((list) => {
      if (cancelled) return;
      setInfographics(list);
      setPhase(list.length > 0 ? "list" : "setup");
      setInfographicsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [deckId]);

  const refreshList = async () => {
    setInfographics(await getInfographicsForDeck(deckId));
  };

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
      setGenerationError("The infographic could not be generated. Try again.");
      setPhase("error");
    }
  };

  const handleDelete = async (id: string) => {
    await deleteInfographic(id);
    await refreshList();
    setViewing(null);
    setPhase("list");
  };

  if (loading || !deck) return <DeckGate loading={loading} error={error} deck={deck} />;
  if (!infographicsLoaded) return <p className="muted">Loading infographics…</p>;

  if (phase === "list") {
    return (
      <InfographicList
        infographics={infographics}
        onView={(infographic) => {
          setViewing(infographic);
          setPhase("view");
        }}
        onDelete={handleDelete}
        onCreate={() => setPhase("setup")}
      />
    );
  }

  if (phase === "setup") {
    return (
      <InfographicSetup
        deckName={deck.name}
        cards={cards}
        ai={ai}
        onAiChange={setAi}
        onGenerate={handleGenerate}
        onBack={infographics.length > 0 ? () => setPhase("list") : undefined}
      />
    );
  }

  if (phase === "generating") {
    return (
      <div className="infographic-generating">
        <span className="chalk-spinner" aria-hidden="true" />
        <p className="muted small">Writing the infographic…</p>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div>
        <ErrorNotice message={generationError ?? "Something went wrong."} />
        <div className="form-actions">
          <button type="button" className="secondary-btn" onClick={() => setPhase("setup")}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  // phase === "view"
  return (
    <InfographicView
      infographic={viewing!}
      totalCardCount={cards.length}
      onBack={() => setPhase("list")}
      onDelete={() => handleDelete(viewing!.id)}
    />
  );
}
```

Also append to `src/index.css`, for the `'generating'` phase's simple loading state:

```css
/* ---------- Infographic: generating ---------- */

.infographic-generating {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 3rem 1rem;
}
```

- [ ] **Step 2: Write `InfographicRoute`**

Create `src/routes/InfographicRoute.tsx`:

```tsx
import { useNavigate, useParams } from "react-router-dom";
import InfographicMode from "../components/InfographicMode";

/** A deck's saved infographics, and creating new ones. */
export default function InfographicRoute() {
  const { deckId = "" } = useParams();
  const navigate = useNavigate();

  return <InfographicMode deckId={deckId} onExit={() => navigate("/")} />;
}
```

- [ ] **Step 3: Add the route**

In `src/routes/router.tsx`, add the lazy import alongside the existing ones:

```ts
const InfographicRoute = lazy(() => import('./InfographicRoute'));
```

And add the route entry alongside `deck/:deckId/test`:

```ts
      { path: 'deck/:deckId/infographic', element: <InfographicRoute /> },
```

- [ ] **Step 4: Wire `DeckRoute`**

In `src/routes/DeckRoute.tsx`, add the `onInfographic` prop:

```tsx
    <DeckManager
      deckId={deckId}
      onStudy={(id) => navigate(`/deck/${id}/study`)}
      onTest={(id) => navigate(`/deck/${id}/test`)}
      onInfographic={(id) => navigate(`/deck/${id}/infographic`)}
      onDeckDeleted={() => navigate("/", { replace: true })}
    />
```

- [ ] **Step 5: Add the button to `DeckManager`**

In `src/components/DeckManager.tsx`'s `Props` interface, add `onInfographic: (deckId: string) => void;` alongside `onStudy`/`onTest`. Add it to the destructured props. In `.manager-actions`, after the existing "Test this deck" button:

```tsx
          <button
            className="secondary-btn"
            onClick={() => onInfographic(deckId)}
            disabled={cards.length === 0}
          >
            Create infographic
          </button>
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 7: Run the full pure-logic regression sweep**

Run each (all should still pass — none of this task's changes touch their logic, this just confirms nothing was disturbed):

```bash
node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs
node --experimental-strip-types --import ./tools/register.mjs tools/test-folders.mjs
```

- [ ] **Step 8: Verify the whole feature end-to-end against the running app**

```bash
npm run dev -- --port 5173 &
for i in $(seq 1 30); do curl -sf http://localhost:5173 >/dev/null && echo UP && break; sleep 1; done
```

With a real browser (or scripted, e.g. Playwright imported directly from its npx cache path if `chromium-cli` isn't installed), seed a deck with a handful of cards directly into IndexedDB (matching the shape `flashcards`/`decks` already use), then confirm:

1. Deck Manager shows "Create infographic", disabled when the deck has no cards, enabled once it does.
2. Clicking it on a deck with **no** saved infographics goes straight to Setup (not an empty List).
3. On Setup: Standard is pre-selected; switching detail levels updates the selected card; "Choose cards" reveals the checklist with Generate disabled until at least one card is checked; switching back to "All cards" re-enables Generate.
4. Generating (with a real key, or against a stub `callModel` response if none is configured for this check) moves through Generating to View, showing the title and every section with its icon and points.
5. "Back to infographics" from View lands on List, now showing the one just created; "+ Create infographic" from List returns to Setup, and Setup's own "Back to your infographics" (visible now that the deck has one) returns to List without generating anything.
6. Generate a second infographic at a different detail level; List now shows both, each with its own detail tag and card count.
7. "Delete" from List (confirmed) removes only that one; the other remains.
8. From the top bar, clicking Back after entering the infographic screen from Deck Manager returns to Deck Manager (the real navigation this feature adds to history) — not into the middle of the List/Setup/View phase state, confirming those phases really are component state and not separate history entries.

- [ ] **Step 9: Commit**

```bash
git add src/components/InfographicMode.tsx src/routes/InfographicRoute.tsx src/routes/router.tsx src/routes/DeckRoute.tsx src/components/DeckManager.tsx src/index.css
git commit -m "$(cat <<'EOF'
Wire the infographic feature into routing and Deck Manager

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
