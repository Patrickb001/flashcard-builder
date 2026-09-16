# Infographic Block Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the infographic feature's single `bullets`-only section shape with an eight-type `InfographicBlock` union (bullets, timeline, table, callout, stat, compare, steps, quote), and move its delete confirmations onto the app's shared `Modal` component.

**Architecture:** The model still returns one JSON object; `parseInfographicResponse` validates and clamps it block-by-block instead of section-by-section, using a `switch` on each block's `type`. Rendering mirrors that split: one small component per block type, dispatched from a `block.type` switch. No block's markup — model-authored or otherwise — ever reaches the DOM as HTML; every block is a typed props object into typed JSX, exactly as today.

**Tech Stack:** React 18 + TypeScript, IndexedDB via `idb`, Vite. Tests run under plain Node (`--experimental-strip-types`) for pure logic, and in a real (optionally headless) browser for anything touching IndexedDB or rendering — this repo has no component test runner, so rendering is checked manually against the dev server.

**Spec:** `docs/superpowers/specs/2026-09-15-infographic-block-schema-design.md` (and its predecessor, `docs/superpowers/specs/2026-09-13-flashcard-infographic-design.md`, for the parts of the feature this plan doesn't change).

## Global Constraints

- No `dangerouslySetInnerHTML`, no iframe, no markup crossing from the model into the DOM — every block is a typed props object into a typed component.
- Clamp, don't reject: a block over a ceiling is truncated or dropped; the response as a whole returns `null` only when zero blocks survive.
- No verbatim/fidelity check on `quote` — accuracy is a prompt instruction, not something parse-time code verifies.
- No migration for old-shaped (`sections`-only) records — none exist yet. A row with no valid `blocks` array is deleted on read, not converted.
- Icons: `bullets` and `timeline` keep the model-chosen 12-name `InfographicIcon` enum. `table`, `callout`, `stat`, `compare`, `steps`, `quote` get one fixed icon each, chosen in code — no `icon` field on those interfaces at all.
- Delete confirmations use the existing `src/components/ui/Modal.tsx` primitive, styled exactly like the folder-delete dialog in `src/components/DeckLibrary.tsx` (`dialog-head`/`dialog-title-row`/`icon-btn`/`body-text`/`dialog-actions` with `ghost-btn` + `btn-danger-solid`) — not `window.confirm`.
- `MAX_TOKENS` for every `infographic-*` task must stay identical between `src/lib/aiTransport.ts` and `src/server/generateHandler.ts` (an existing invariant this plan must not break).

---

## File Structure

**Modify:**
- `src/types.ts` — `InfographicSection`/`sections` → the `InfographicBlock` union / `blocks`.
- `src/lib/infographicPrompt.ts` — per-block validators, ceilings, and the rewritten prompt rubric.
- `src/lib/infographicGenerator.ts` — one field rename (`sections` → `blocks`).
- `src/lib/aiTransport.ts` / `src/server/generateHandler.ts` — bump `infographic-standard`'s `MAX_TOKENS`.
- `src/db/db.ts` — `getInfographicsForDeck` drops (and deletes) any row without a valid `blocks` array.
- `src/components/infographic/InfographicList.tsx` — block count in the meta line; delete confirmation moves onto `Modal`.
- `src/components/infographic/InfographicView.tsx` — dispatches to `blocks.tsx`; delete confirmation moves onto `Modal`.
- `src/index.css` — new block-type styles, appended after the existing `.infographic-section-body li + li` rule.
- `tools/test-infographic.mjs` — rewritten/extended for the block-based parser and the new copy helper.
- `tools/idb-check.html` — one new check block for the invalid-row cleanup.

**Create:**
- `src/lib/infographicCopy.ts` — `deleteInfographicModalCopy(title)`, mirroring `deckFolders.ts`'s `deleteFolderModalCopy`.
- `src/components/infographic/blocks.tsx` — `InfographicBlockCard`, one renderer per block type.

---

### Task 1: Data model, and the parser for bullets/callout/stat/quote

**Files:**
- Modify: `src/types.ts`
- Modify: `src/lib/infographicPrompt.ts`
- Test: `tools/test-infographic.mjs`

**Interfaces:**
- Produces: `InfographicBlock` (and its eight member interfaces `BulletsBlock`/`TimelineBlock`/`TableBlock`/`CalloutBlock`/`StatBlock`/`CompareBlock`/`StepsBlock`/`QuoteBlock`, plus `CompareColumn`) from `src/types.ts`. `Infographic.blocks: InfographicBlock[]`, `LlmInfographic.blocks: InfographicBlock[]`.
- Produces: `parseInfographicResponse(text, deckName, detail): LlmInfographic | null` from `src/lib/infographicPrompt.ts` — same signature as today, now validating `blocks` instead of `sections`. Handles `bullets`, `callout`, `stat`, `quote` fully in this task; `timeline`/`table`/`compare`/`steps` are added in Task 2 (until then, a block of one of those types is dropped as unrecognized — this is correct interim behavior, not a bug).

- [ ] **Step 1: Replace the section shape in `src/types.ts`**

Delete the existing `InfographicSection` interface and the `sections` fields on `Infographic`/`LlmInfographic` (currently lines 74-105), replacing that whole block with:

```ts
/**
 * One piece of a generated infographic. Eight shapes, one for each way the
 * model can present an idea — a plain bullet list is still the default, but
 * a table, a stat, a compare, or a pulled quote are now real options too.
 *
 * `bullets` and `timeline` carry a model-chosen `icon` from the fixed
 * InfographicIcon enum below. The other six don't — each gets one icon
 * fixed in code (src/components/infographic/blocks.tsx), because none of
 * them ever had a reason to vary: a table always reads as a table.
 */
export interface BulletsBlock {
  type: 'bullets';
  icon: InfographicIcon;
  heading: string;
  points: string[];
}

export interface TimelineBlock {
  type: 'timeline';
  icon: InfographicIcon;
  heading: string;
  steps: { label: string }[];
  caption: string;
}

export interface TableBlock {
  type: 'table';
  heading: string;
  columns: string[];
  rows: string[][];
}

export interface CalloutBlock {
  type: 'callout';
  tone: 'warning' | 'info';
  text: string;
}

export interface StatBlock {
  type: 'stat';
  heading: string;
  value: string;
  unit?: string;
  caption: string;
}

export interface CompareColumn {
  label: string;
  points: string[];
}

export interface CompareBlock {
  type: 'compare';
  heading: string;
  left: CompareColumn;
  right: CompareColumn;
}

export interface StepsBlock {
  type: 'steps';
  heading: string;
  items: string[];
}

/**
 * One idea pulled from a single card. Accurate, not verbatim — the model
 * may reword for brevity as long as it stays true to what the card says;
 * nothing here checks the wording against the source card (see
 * infographicPrompt.ts's clamping, which only bounds length).
 */
export interface QuoteBlock {
  type: 'quote';
  text: string;
}

export type InfographicBlock =
  | BulletsBlock
  | TimelineBlock
  | TableBlock
  | CalloutBlock
  | StatBlock
  | CompareBlock
  | StepsBlock
  | QuoteBlock;

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
  blocks: InfographicBlock[];
  /** Which cards this one was built from, for the list screen's "N cards" line. */
  cardIds: string[];
  createdAt: number;
}

/**
 * What the model's response actually contains — title and blocks only.
 * `Infographic` adds `id`, `deckId`, `detail`, `cardIds` and `createdAt`,
 * none of which are in the model's own reply. Same split `LlmCard`
 * (cardPrompt.ts) already keeps from the stored `Flashcard`.
 */
export interface LlmInfographic {
  title: string;
  blocks: InfographicBlock[];
}
```

- [ ] **Step 2: Rewrite `tools/test-infographic.mjs` for the block shape (will fail until Step 3)**

Replace the whole file:

```js
import { parseInfographicResponse } from '../src/lib/infographicPrompt.ts';

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
  { title: 'Cell Biology', blocks: JSON.parse(basicReply).blocks }
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
  check('a value over 12 chars is clamped', result.blocks[0].value.length, 12);
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

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs`
Expected: FAIL — `parseInfographicResponse` still reads `raw.sections`, which is `undefined` on every `{ blocks: [...] }` fixture above, so every case returns `null` and most checks fail.

- [ ] **Step 4: Rewrite `parseInfographicResponse` and its helpers in `src/lib/infographicPrompt.ts`**

Replace the whole block from `const CEILINGS` (currently lines 28-38) through the end of `parseInfographicResponse` (currently line 153) with:

```ts
/** The per-level ceiling on total blocks, and the level-independent ceiling
 * shared by every "list of short strings" field (bullets' points, steps'
 * items, a compare column's points) — the same numbers the old per-section
 * points ceiling used, now spent per-list rather than per-section. */
const TOTAL_BLOCKS_CEILING: Record<InfographicDetail, number> = { basic: 3, standard: 6, detailed: 10 };
const POINTS_CEILING: Record<InfographicDetail, number> = { basic: 4, standard: 5, detailed: 6 };

/** At most this many of each "dense" block type, regardless of level —
 * keeps Detailed from turning into ten tables back to back. */
const DENSE_TYPE_CEILING: Record<'stat' | 'compare' | 'table', number> = { stat: 1, compare: 1, table: 2 };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Trims and clamps to `max` chars with a trailing ellipsis; null if nothing survives. */
function clampText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

function validateBullets(raw: Record<string, unknown>, detail: InfographicDetail): BulletsBlock | null {
  if (!isNonEmptyString(raw.heading)) return null;
  if (!Array.isArray(raw.points)) return null;
  const points = raw.points
    .filter((p): p is string => typeof p === 'string')
    .slice(0, POINTS_CEILING[detail])
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (points.length === 0) return null;
  const icon = typeof raw.icon === 'string' && (ICONS as string[]).includes(raw.icon) ? (raw.icon as InfographicIcon) : ('list' as const);
  return { type: 'bullets', icon, heading: (raw.heading as string).trim(), points };
}

function validateCallout(raw: Record<string, unknown>): CalloutBlock | null {
  const text = clampText(raw.text, 220);
  if (!text) return null;
  const tone = raw.tone === 'info' ? 'info' : ('warning' as const);
  return { type: 'callout', tone, text };
}

function validateStat(raw: Record<string, unknown>): StatBlock | null {
  if (!isNonEmptyString(raw.heading)) return null;
  const value = clampText(raw.value, 12);
  if (!value) return null;
  const caption = clampText(raw.caption, 140) ?? '';
  const unit = typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit.trim() : undefined;
  return { type: 'stat', heading: (raw.heading as string).trim(), value, ...(unit ? { unit } : {}), caption };
}

function validateQuote(raw: Record<string, unknown>): QuoteBlock | null {
  const text = clampText(raw.text, 200);
  if (!text) return null;
  return { type: 'quote', text };
}

/**
 * One switch per block type — unrecognized types (including the four not
 * yet implemented as of this task: timeline/table/compare/steps) fall
 * through to `default` and are dropped, the same treatment an unrecognized
 * `icon` already gets.
 */
function validateBlock(raw: unknown, detail: InfographicDetail): InfographicBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  switch (item.type) {
    case 'bullets':
      return validateBullets(item, detail);
    case 'callout':
      return validateCallout(item);
    case 'stat':
      return validateStat(item);
    case 'quote':
      return validateQuote(item);
    default:
      return null;
  }
}

/** Applies the total-block ceiling and the dense-type combined cap, in
 * order — a dense block that's over its own cap is skipped without
 * consuming a slot in the total ceiling, so a later non-dense block can
 * still take its place. */
function applyBlockCeilings(blocks: InfographicBlock[], detail: InfographicDetail): InfographicBlock[] {
  const denseUsed: Record<'stat' | 'compare' | 'table', number> = { stat: 0, compare: 0, table: 0 };
  const kept: InfographicBlock[] = [];
  for (const block of blocks) {
    if (kept.length >= TOTAL_BLOCKS_CEILING[detail]) break;
    if (block.type === 'stat' || block.type === 'compare' || block.type === 'table') {
      if (denseUsed[block.type] >= DENSE_TYPE_CEILING[block.type]) continue;
      denseUsed[block.type] += 1;
    }
    kept.push(block);
  }
  return kept;
}

/**
 * Reads the model's reply as one JSON object, tolerating a markdown fence,
 * then validates and clamps each block, then applies the total/dense-type
 * ceilings above. Clamps rather than rejects a single block, so one
 * malformed block among several good ones doesn't throw the whole reply
 * away.
 *
 * Returns null only when nothing usable could be read at all: the reply
 * isn't a JSON object, or it parses but zero blocks survive.
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

  const raw = parsed as { title?: unknown; blocks?: unknown };
  if (!Array.isArray(raw.blocks)) return null;

  const validated = raw.blocks
    .map((item) => validateBlock(item, detail))
    .filter((block): block is InfographicBlock => block !== null);

  const blocks = applyBlockCeilings(validated, detail);
  if (blocks.length === 0) return null;

  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : deckName;

  return { title, blocks };
}
```

Also update the type-only import at the top of the file (currently line 2) to pull in every block interface:

```ts
import type {
  BulletsBlock,
  CalloutBlock,
  InfographicBlock,
  InfographicDetail,
  InfographicIcon,
  LlmInfographic,
  QuoteBlock,
  StatBlock,
} from '../types';
```

(`TimelineBlock`/`TableBlock`/`CompareBlock`/`CompareColumn`/`StepsBlock` are added to this import in Task 2, when their validators are written — importing a type this task doesn't use yet would be flagged as unused.)

- [ ] **Step 5: Run the test to confirm it passes**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs`
Expected: `All passed.`, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/lib/infographicPrompt.ts tools/test-infographic.mjs
git commit -m "$(cat <<'EOF'
Replace infographic sections with a block union (bullets/callout/stat/quote)

First half of the eight-block schema: the data model and validation for
the four "flat" block types, plus the total-block and dense-type
ceilings the whole schema uses. timeline/table/compare/steps follow in
the next commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Parser for timeline/table/compare/steps

**Files:**
- Modify: `src/lib/infographicPrompt.ts`
- Test: `tools/test-infographic.mjs`

**Interfaces:**
- Consumes: `POINTS_CEILING`, `isNonEmptyString`, `clampText`, `validateBlock`'s `switch` (all from Task 1, same file).
- Produces: `parseInfographicResponse` now handles all eight block types.

- [ ] **Step 1: Add test cases for the four remaining block types (will fail until Step 3)**

In `tools/test-infographic.mjs`, insert the following before the `console.log('\ntotal block count ceiling');` section (i.e. right after the "unrecognized block type" block), and update the import at the top to add `deleteInfographicModalCopy` is **not** part of this step (that's Task 6) — only the block-type cases below:

```js
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
```

- [ ] **Step 2: Run the test to confirm the new cases fail**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs`
Expected: the new `timeline`/`table`/`compare`/`steps` checks FAIL (each currently returns `null` — `validateBlock`'s `default` case drops them); every Task 1 check still passes.

- [ ] **Step 3: Implement the four remaining validators**

In `src/lib/infographicPrompt.ts`, add above `validateBlock`:

```ts
const TIMELINE_STEPS_CEILING = 6;
const TABLE_MAX_COLUMNS = 4;
const TABLE_MAX_ROWS = 6;
const TABLE_CELL_CHARS = 60;

function validateTimeline(raw: Record<string, unknown>): TimelineBlock | null {
  if (!isNonEmptyString(raw.heading)) return null;
  if (!Array.isArray(raw.steps)) return null;
  const steps = raw.steps
    .map((s) => (s && typeof s === 'object' ? (s as { label?: unknown }).label : undefined))
    .filter(isNonEmptyString)
    .slice(0, TIMELINE_STEPS_CEILING)
    .map((label) => ({ label: label.trim() }));
  if (steps.length === 0) return null;
  const icon = typeof raw.icon === 'string' && (ICONS as string[]).includes(raw.icon) ? (raw.icon as InfographicIcon) : ('clock' as const);
  const caption = clampText(raw.caption, 140) ?? '';
  return { type: 'timeline', icon, heading: (raw.heading as string).trim(), steps, caption };
}

function validateTable(raw: Record<string, unknown>): TableBlock | null {
  if (!isNonEmptyString(raw.heading)) return null;
  if (!Array.isArray(raw.columns) || !Array.isArray(raw.rows)) return null;
  const columns = raw.columns
    .filter(isNonEmptyString)
    .slice(0, TABLE_MAX_COLUMNS)
    .map((c) => clampText(c, TABLE_CELL_CHARS) as string);
  if (columns.length === 0) return null;
  const rows = raw.rows
    .filter((r): r is unknown[] => Array.isArray(r))
    .slice(0, TABLE_MAX_ROWS)
    .map((r) => r.slice(0, columns.length).map((cell) => clampText(cell, TABLE_CELL_CHARS) ?? ''))
    .filter((r) => r.length > 0);
  if (rows.length === 0) return null;
  return { type: 'table', heading: (raw.heading as string).trim(), columns, rows };
}

function validateCompareColumn(raw: unknown, detail: InfographicDetail): CompareColumn | null {
  if (!raw || typeof raw !== 'object') return null;
  const col = raw as { label?: unknown; points?: unknown };
  if (!isNonEmptyString(col.label) || !Array.isArray(col.points)) return null;
  const points = col.points
    .filter((p): p is string => typeof p === 'string')
    .slice(0, POINTS_CEILING[detail])
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (points.length === 0) return null;
  return { label: col.label.trim(), points };
}

function validateCompare(raw: Record<string, unknown>, detail: InfographicDetail): CompareBlock | null {
  if (!isNonEmptyString(raw.heading)) return null;
  const left = validateCompareColumn(raw.left, detail);
  const right = validateCompareColumn(raw.right, detail);
  if (!left || !right) return null;
  return { type: 'compare', heading: (raw.heading as string).trim(), left, right };
}

function validateSteps(raw: Record<string, unknown>, detail: InfographicDetail): StepsBlock | null {
  if (!isNonEmptyString(raw.heading)) return null;
  if (!Array.isArray(raw.items)) return null;
  const items = raw.items
    .filter((i): i is string => typeof i === 'string')
    .slice(0, POINTS_CEILING[detail])
    .map((i) => i.trim())
    .filter((i) => i.length > 0);
  if (items.length === 0) return null;
  return { type: 'steps', heading: (raw.heading as string).trim(), items };
}
```

Then extend `validateBlock`'s `switch`, adding these four cases above `default`:

```ts
    case 'timeline':
      return validateTimeline(item);
    case 'table':
      return validateTable(item);
    case 'compare':
      return validateCompare(item, detail);
    case 'steps':
      return validateSteps(item, detail);
```

And extend the type-only import from Task 1 to include the newly-used types:

```ts
import type {
  BulletsBlock,
  CalloutBlock,
  CompareBlock,
  CompareColumn,
  InfographicBlock,
  InfographicDetail,
  InfographicIcon,
  LlmInfographic,
  QuoteBlock,
  StatBlock,
  StepsBlock,
  TableBlock,
  TimelineBlock,
} from '../types';
```

- [ ] **Step 4: Run the test to confirm everything passes**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs`
Expected: `All passed.`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/infographicPrompt.ts tools/test-infographic.mjs
git commit -m "$(cat <<'EOF'
Add parser validation for timeline/table/compare/steps blocks

Completes the eight-block schema's parsing half, started in the
previous commit. All eight InfographicBlock types are now validated
and clamped.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Rewrite the prompt text with a block-selection rubric

**Files:**
- Modify: `src/lib/infographicPrompt.ts`
- Test: `tools/test-infographic.mjs`

**Interfaces:**
- Consumes: `ICONS` (Task 1, same file).
- Produces: `INFOGRAPHIC_SYSTEM_PROMPTS: Record<InfographicDetail, string>` — same export name and shape, new text.

- [ ] **Step 1: Add prompt-coverage assertions (will fail until Step 3)**

Add `INFOGRAPHIC_SYSTEM_PROMPTS` to the import at the top of `tools/test-infographic.mjs`:

```js
import { parseInfographicResponse, INFOGRAPHIC_SYSTEM_PROMPTS } from '../src/lib/infographicPrompt.ts';
```

Then append, just before the final `console.log(failures === 0 ...)` line:

```js
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
```

- [ ] **Step 2: Run the test to confirm the new checks fail**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs`
Expected: the new prompt-coverage checks FAIL — the prompt text still says `"sections"` and never mentions `table`/`callout`/`stat`/etc.

- [ ] **Step 3: Rewrite `buildInfographicPrompt` and its supporting constants**

Replace `TARGET_GUIDANCE` and `buildInfographicPrompt` (currently lines 40-66) with:

```ts
/** Per-level target guidance, folded into each level's own prompt text below. */
const TARGET_GUIDANCE: Record<InfographicDetail, string> = {
  basic: 'roughly 2-3 blocks',
  standard: 'roughly 4-6 blocks',
  detailed: 'roughly 7-10 blocks',
};

/** Basic keeps this short deliberately — with only 2-3 blocks, there's rarely
 * room for more than the default type plus maybe one standout number. */
const BLOCK_RUBRIC_BASIC = `Stick mostly to "bullets"; reach for "stat" only if one number is genuinely worth calling out on its own.`;

const BLOCK_RUBRIC_FULL = `Pick whichever block best fits each idea — do not default to "bullets" for everything:
- bullets — a short list of related points under one heading. The default when nothing more specific applies.
- timeline — steps that each have a real time or interval label (e.g. "1 day", "3 days"). Use "steps" instead when the sequence has no time attached.
- table — data that reads naturally as rows and columns (e.g. options and their effects).
- callout — one important warning or note that deserves visual emphasis, not another bullet.
- stat — one standout number worth calling out on its own, not a list of several numbers.
- compare — exactly two things being weighed against each other, never more than two.
- steps — an ordered process or sequence with no time labels attached.
- quote — one idea pulled from a single card. Light rewording for clarity or brevity is fine, but never add a claim the card didn't make.`;

function buildInfographicPrompt(detail: InfographicDetail): string {
  const rubric = detail === 'basic' ? BLOCK_RUBRIC_BASIC : BLOCK_RUBRIC_FULL;
  return `You turn a student's flashcards into a single-page-style infographic they can use to review the material at a glance.

You are given some flashcards from one deck (front, back, and sometimes a topic). Write ${TARGET_GUIDANCE[detail]} — aim for that range, but it is a guide, not a hard limit; write what the material actually supports.

${rubric}

Reply with ONLY a JSON object, no prose before or after, shaped exactly like this:

{
  "title": "A short title for the whole infographic",
  "blocks": [
    { "type": "bullets", "icon": "one of the icon names below", "heading": "A short heading", "points": ["A short point.", "Another short point."] },
    { "type": "stat", "heading": "A short heading", "value": "62", "unit": "days", "caption": "One sentence of context." }
  ]
}

Each block type's own fields:
- bullets: icon, heading, points (array of short strings)
- timeline: icon, heading, steps (array of { "label": "a short time label" }), caption (one sentence)
- table: heading, columns (array of short column names), rows (array of arrays of short cell strings, one array per row)
- callout: tone ("warning" or "info"), text (one to two sentences)
- stat: heading, value (a short number or figure), unit (optional, e.g. "days"), caption (one sentence)
- compare: heading, left and right (each { "label": "a short column name", "points": ["a short point", ...] })
- steps: heading, items (array of short strings, one per step)
- quote: text (one idea from a single card, one to two sentences)

Rules:
1. SYNTHESIZE, DON'T TRANSCRIBE — a point should read as a distilled idea, not a card's back pasted in verbatim. Group related cards into one block rather than writing one block per card.
2. icon (on "bullets" and "timeline" blocks only — no other block type takes an icon) MUST be exactly one of: ${ICONS.join(', ')}. Pick whichever reads best for that block's topic; never invent a name outside this list.
3. Keep headings, points, and captions short — this is read at a glance, not studied line by line.
4. Every block needs whatever its own fields require above; never return an empty blocks array.`;
}
```

(`INFOGRAPHIC_SYSTEM_PROMPTS` itself, currently lines 80-84, is unchanged — it already just calls `buildInfographicPrompt` per level.)

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs`
Expected: `All passed.`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/infographicPrompt.ts tools/test-infographic.mjs
git commit -m "$(cat <<'EOF'
Rewrite the infographic prompt with a block-selection rubric

Without explicit guidance the model defaults to "bullets" for
everything, which would make the new schema invisible in practice.
Basic's rubric stays short (2-3 blocks rarely need more); Standard
and Detailed get the full eight-type rubric.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Generator wiring and the standard-level token budget

**Files:**
- Modify: `src/lib/infographicGenerator.ts`
- Modify: `src/lib/aiTransport.ts`
- Modify: `src/server/generateHandler.ts`

**Interfaces:**
- Consumes: `parseInfographicResponse` (Task 1/2) now returns `{ title, blocks }`.
- Produces: `generateInfographic(...)`'s returned `Infographic` now has `blocks` instead of `sections` — the shape `InfographicMode.tsx` (Task 9 onward) and `db.ts` (Task 5) consume.

- [ ] **Step 1: Rename the field in the generator**

In `src/lib/infographicGenerator.ts`, change line 72:

```ts
    sections: parsed.sections,
```

to:

```ts
    blocks: parsed.blocks,
```

- [ ] **Step 2: Bump the standard-level token ceiling in both places that must stay in step**

In `src/lib/aiTransport.ts`, change line 76:

```ts
  'infographic-standard': 4000,
```

to:

```ts
  // Raised from 4000: a table or compare block's nested arrays cost more
  // JSON per block than a bullets section did, and Standard can now carry
  // up to 6 of them. Detailed stays at 8000 — its total-block ceiling (10)
  // is lower than the old sections ceiling (14) it replaced, which offsets
  // the added per-block verbosity.
  'infographic-standard': 6000,
```

In `src/server/generateHandler.ts`, change line 38 the same way:

```ts
  'infographic-standard': 6000,
```

(Leave the comment only in `aiTransport.ts` — `generateHandler.ts`'s own comment at lines 27-29 already points there for the reasoning, matching how the rest of this table is documented.)

- [ ] **Step 3: Verify no stale references remain, and existing tests still pass**

Run: `grep -n "sections" src/lib/infographicGenerator.ts`
Expected: no output.

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs`
Expected: `All passed.` (this task doesn't change parsing behavior, only wiring).

Note for the next task's implementer: `npx tsc -b` will still report errors in `src/components/infographic/InfographicView.tsx` and `src/components/infographic/InfographicList.tsx` at this point — both still read `.sections`. That's expected and is fixed in Task 9, not here.

- [ ] **Step 4: Commit**

```bash
git add src/lib/infographicGenerator.ts src/lib/aiTransport.ts src/server/generateHandler.ts
git commit -m "$(cat <<'EOF'
Wire the generator to the block schema, raise Standard's token ceiling

blocks replaces sections in the stored Infographic the generator
assembles. Standard's MAX_TOKENS moves from 4000 to 6000 in both
aiTransport.ts and generateHandler.ts (kept in step, per the existing
invariant) — richer block types cost more JSON per block than a plain
bullets section did.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Storage — delete rows with no valid `blocks` array on read

**Files:**
- Modify: `src/db/db.ts`
- Test: `tools/idb-check.html`

**Interfaces:**
- Produces: `getInfographicsForDeck(deckId): Promise<Infographic[]>` — same signature, now also deletes (not just filters) any row whose `blocks` isn't an array before returning.

- [ ] **Step 1: Add the check block to `tools/idb-check.html` (will fail until Step 2)**

Insert this new numbered check between check 7 (folder names) and the final `log('')` / `RESULT` lines:

```js
    // ---- 8. getInfographicsForDeck deletes a row with no valid blocks array ----
    {
      const id = 'probe-infographic';
      await db.saveDeckWithCards(deck(id), []);
      await db.saveInfographic({
        id: 'probe-info-good', deckId: id, title: 'Good', detail: 'basic',
        blocks: [{ type: 'bullets', icon: 'book', heading: 'H', points: ['p'] }],
        cardIds: [], createdAt: Date.now(),
      });
      // Deliberately the pre-block shape. Nothing in this app writes this
      // anymore, but a stray row like it should be cleaned up, not shown.
      await db.saveInfographic({
        id: 'probe-info-bad', deckId: id, title: 'Bad', detail: 'basic',
        sections: [{ heading: 'H', icon: 'book', points: ['p'] }],
        cardIds: [], createdAt: Date.now(),
      });

      const list = await db.getInfographicsForDeck(id);
      check('only the valid row is returned', list.map((i) => i.id), ['probe-info-good']);

      const raw = await new Promise((resolve, reject) => {
        const req = indexedDB.open('flashcard-forge');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const rawGet = await new Promise((resolve, reject) => {
        const r = raw.transaction('infographics', 'readonly').objectStore('infographics').get('probe-info-bad');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      raw.close();
      check('the invalid row is actually gone from the store, not just filtered from the list', rawGet, undefined);

      await db.deleteInfographic('probe-info-good');
      await db.deleteDeck(id);
    }
```

Also update the summary comment at the top of the section (`// ---- 5. deleteFolder ...` etc. are unaffected) — no other edits needed in this file besides the new block above.

- [ ] **Step 2: Run the check against the current code to confirm it fails**

```bash
npx vite --port 5199 --strictPort &
node tools/idb-collector.cjs result.txt &
chrome --headless=new --user-data-dir=/tmp/idb-check-$$ http://localhost:5199/tools/idb-check.html
cat result.txt
```

Expected: check 8's first assertion fails — `getInfographicsForDeck` currently returns both rows (`list.map(i => i.id)` is `['probe-info-good', 'probe-info-bad']` or similar, not the expected single-item array), since it doesn't filter anything yet.

- [ ] **Step 3: Implement the cleanup in `getInfographicsForDeck`**

In `src/db/db.ts`, replace lines 533-538 with:

```ts
/**
 * Every infographic saved for a deck, newest first.
 *
 * Also the one place a straggler from before this shape existed would turn
 * up — nothing has ever written one, so this is a safety net, not a
 * migration: a row with no valid `blocks` array is deleted on the spot
 * rather than handed to a screen that expects one.
 */
export async function getInfographicsForDeck(deckId: string): Promise<Infographic[]> {
  const db = await getDB();
  const infographics = await db.getAllFromIndex('infographics', 'by-deckId', deckId);
  const valid: Infographic[] = [];
  for (const infographic of infographics) {
    if (Array.isArray((infographic as Infographic).blocks)) {
      valid.push(infographic);
    } else {
      await db.delete('infographics', infographic.id);
    }
  }
  return valid.sort((a, b) => b.createdAt - a.createdAt);
}
```

- [ ] **Step 4: Run the check again to confirm it passes**

Repeat Step 2's commands.
Expected: `RESULT: ALL PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/db/db.ts tools/idb-check.html
git commit -m "$(cat <<'EOF'
Delete invalid-shaped infographic rows on read instead of migrating

No pre-block infographic has ever been written, so there's nothing to
migrate — but getInfographicsForDeck now cleans up (deletes, not just
skips) any row without a real blocks array, as a safety net rather
than a migration path.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `deleteInfographicModalCopy`

**Files:**
- Create: `src/lib/infographicCopy.ts`
- Test: `tools/test-infographic.mjs`

**Interfaces:**
- Produces: `deleteInfographicModalCopy(title: string): { title: string; body: string }` — consumed by `InfographicList.tsx`/`InfographicView.tsx` in Task 10.

- [ ] **Step 1: Add the test (will fail — the module doesn't exist yet)**

Add to the top of `tools/test-infographic.mjs`:

```js
import { deleteInfographicModalCopy } from '../src/lib/infographicCopy.ts';
```

Append, just before the final `console.log(failures === 0 ...)` line:

```js
// ---------- deleteInfographicModalCopy ----------

console.log('\ndeleteInfographicModalCopy');
check(
  'names the infographic in the title',
  deleteInfographicModalCopy('Why Your Reviews Get Farther Apart').title,
  'Delete "Why Your Reviews Get Farther Apart"?'
);
check("the body always warns it can't be undone", deleteInfographicModalCopy('Anything').body, "This can't be undone.");
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs`
Expected: FAIL to even start — `Cannot find module '../src/lib/infographicCopy.ts'`.

- [ ] **Step 3: Create `src/lib/infographicCopy.ts`**

```ts
/** The title and body of the delete-infographic dialog. */
export interface DeleteInfographicCopy {
  title: string;
  body: string;
}

/**
 * The copy for the delete-infographic dialog: a title naming it, and a body
 * warning the action can't be undone.
 *
 * Kept as a pure function, the same way deckFolders.ts's own
 * deleteFolderModalCopy is — so the wording is checked here
 * (tools/test-infographic.mjs) rather than only ever seen in the browser.
 */
export function deleteInfographicModalCopy(title: string): DeleteInfographicCopy {
  return {
    title: `Delete "${title}"?`,
    body: "This can't be undone.",
  };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs`
Expected: `All passed.`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/infographicCopy.ts tools/test-infographic.mjs
git commit -m "$(cat <<'EOF'
Add deleteInfographicModalCopy, mirroring deckFolders' delete copy

A small pure helper for the delete-infographic dialog's title/body,
in the same style as deleteFolderModalCopy — used by the Modal
migration in a later task.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Block rendering — bullets, callout, stat, quote

**Files:**
- Create: `src/components/infographic/blocks.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: `InfographicBlock` (Task 1), `INFOGRAPHIC_ICONS` (`src/components/infographic/icons.tsx`, unchanged).
- Produces: `InfographicBlockCard({ block }: { block: InfographicBlock })`, default export — consumed by `InfographicView.tsx` in Task 9. Handles `bullets`/`callout`/`stat`/`quote` in this task; `timeline`/`table`/`compare`/`steps` render as nothing (`default: return null`) until Task 8.

There is no component test runner in this repo (`package.json` has no test script, no `@testing-library/*`); verification here is a manual check against the running dev server, using a hand-saved fixture — the same "poke the browser directly" approach `tools/idb-check.html` already uses for storage.

- [ ] **Step 1: Create `src/components/infographic/blocks.tsx`**

```tsx
import type { InfographicBlock } from "../../types";
import { INFOGRAPHIC_ICONS } from "./icons";

const CALLOUT_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3 2 20h20L12 3Z" />
    <path d="M12 10v4M12 17h.01" />
  </svg>
);

const STAT_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="8.2" />
    <path d="M9 12h6M12 9v6" />
  </svg>
);

/**
 * One block, dispatched by its `type`. Every case is a typed props object
 * into typed JSX — nothing here ever touches the model's own markup,
 * because the model never sends any (see infographicPrompt.ts's clamped
 * schema, which only ever returns structured JSON).
 *
 * bullets/timeline take their icon from the model-chosen InfographicIcon
 * enum; every other type gets one icon fixed here in code — see the
 * Decisions table in the design spec for why.
 */
export default function InfographicBlockCard({ block }: { block: InfographicBlock }) {
  switch (block.type) {
    case "bullets":
      return (
        <div className="infographic-section">
          <div className="infographic-section-icon">{INFOGRAPHIC_ICONS[block.icon]}</div>
          <div className="infographic-section-body">
            <h4>{block.heading}</h4>
            <ul>
              {block.points.map((point, i) => (
                <li key={i}>{point}</li>
              ))}
            </ul>
          </div>
        </div>
      );

    case "callout":
      return (
        <div className={`infographic-section infographic-callout${block.tone === "info" ? " info" : ""}`}>
          <div className="infographic-section-icon">{CALLOUT_ICON}</div>
          <div className="infographic-section-body">
            <p>{block.text}</p>
          </div>
        </div>
      );

    case "stat":
      return (
        <div className="infographic-section" aria-label={`${block.value}${block.unit ?? ""}: ${block.caption}`}>
          <div className="infographic-section-icon">{STAT_ICON}</div>
          <div className="infographic-section-body">
            <h4>{block.heading}</h4>
            <div className="infographic-stat-value">
              {block.value}
              {block.unit && <span className="unit">{block.unit}</span>}
            </div>
            <p className="infographic-stat-caption">{block.caption}</p>
          </div>
        </div>
      );

    case "quote":
      return (
        <div className="infographic-section infographic-quote">
          <div className="infographic-quote-mark" aria-hidden="true">
            &ldquo;
          </div>
          <p className="infographic-quote-text">{block.text}</p>
        </div>
      );

    // timeline / table / compare / steps: added in the next task.
    default:
      return null;
  }
}
```

- [ ] **Step 2: Add CSS for the four new block types**

In `src/index.css`, insert the following immediately after the existing `.infographic-section-body li + li { margin-top: 0.15rem; }` rule (currently line 2373) and before `.page-break` (currently line 2375):

```css
.infographic-callout {
  border-left: 3px solid var(--danger);
  background: var(--danger-soft);
}

.infographic-callout.info {
  border-left-color: var(--accent);
  background: var(--accent-soft);
}

.infographic-callout .infographic-section-icon {
  background: transparent;
  color: var(--danger);
  width: auto;
  height: auto;
}

.infographic-callout.info .infographic-section-icon {
  color: var(--accent);
}

.infographic-callout p {
  margin: 0;
  font-size: 0.86rem;
  color: var(--text-primary);
  line-height: 1.55;
}

.infographic-stat-value {
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  margin-bottom: 0.35rem;
}

.infographic-stat-value .unit {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-left: 0.15rem;
}

.infographic-stat-caption {
  margin: 0;
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.infographic-quote {
  background: var(--surface-raised);
  align-items: flex-start;
}

.infographic-quote-mark {
  font-family: Georgia, serif;
  font-size: 2.4rem;
  line-height: 0.5;
  color: var(--border-strong);
}

.infographic-quote-text {
  margin: 0;
  font-size: 0.92rem;
  font-style: italic;
  color: var(--text-primary);
  line-height: 1.6;
}
```

- [ ] **Step 3: Manual verification against the dev server**

This task's component isn't wired into `InfographicView` yet (that's Task 9), so verify it in isolation via a hand-saved fixture:

Run: `npm run dev`, then open the app in a browser and navigate to any deck with at least one card, so its URL contains a real `deckId` (visible in the address bar as `/deck/<id>/...`).

In the browser devtools console, run (replacing `<deckId>` with that real id):

```js
const db = await import('/src/db/db.ts');
await db.saveInfographic({
  id: 'fixture-simple-blocks',
  deckId: '<deckId>',
  title: 'Block Fixture — Simple Types',
  detail: 'standard',
  blocks: [
    { type: 'bullets', icon: 'book', heading: 'Bullets', points: ['One point.', 'Another point.'] },
    { type: 'callout', tone: 'warning', text: 'A warning callout.' },
    { type: 'callout', tone: 'info', text: 'An info callout.' },
    { type: 'stat', heading: 'Longest Interval', value: '62', unit: 'days', caption: 'After four Good reviews.' },
    { type: 'quote', text: "Mitochondria are the cell's power plants." },
  ],
  cardIds: [],
  createdAt: Date.now(),
});
```

Since `InfographicView` doesn't yet call `InfographicBlockCard` (Task 9), this step only confirms the fixture saves without error and the CSS classes exist with no console errors:

Run in the console: `document.styleSheets.length > 0 && [...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => r.selectorText === '.infographic-callout') } catch { return false } })`
Expected: `true`.

Leave `fixture-simple-blocks` saved — Task 9's manual check reuses it.

- [ ] **Step 4: Commit**

```bash
git add src/components/infographic/blocks.tsx src/index.css
git commit -m "$(cat <<'EOF'
Add block renderers for bullets/callout/stat/quote

InfographicBlockCard dispatches on block.type, one small component
per shape. timeline/table/compare/steps render nothing until the
next commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Block rendering — timeline, table, compare, steps

**Files:**
- Modify: `src/components/infographic/blocks.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: `InfographicBlockCard`'s existing `switch` (Task 7).
- Produces: `InfographicBlockCard` now handles all eight block types.

- [ ] **Step 1: Add the remaining three fixed icons and four switch cases**

In `src/components/infographic/blocks.tsx`, add after `STAT_ICON`:

```tsx
const TABLE_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M3.5 10h17M9.5 4.5v15" />
  </svg>
);

const COMPARE_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 3v18M16 3v18M4 8h4M16 8h4M4 16h4M16 16h4" />
  </svg>
);

const STEPS_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 6h14M5 12h14M5 18h9" />
  </svg>
);
```

Replace the `// timeline / table / compare / steps: added in the next task.\n    default:\n      return null;` fallback with:

```tsx
    case "timeline":
      return (
        <div className="infographic-section">
          <div className="infographic-section-icon">{INFOGRAPHIC_ICONS[block.icon]}</div>
          <div className="infographic-section-body">
            <h4>{block.heading}</h4>
            <div className="infographic-timeline-track">
              {block.steps.map((step, i) => (
                <div className="infographic-timeline-step" key={i}>
                  <div className="infographic-timeline-dot" />
                  <b>{step.label}</b>
                </div>
              ))}
            </div>
            <p className="infographic-timeline-caption">{block.caption}</p>
          </div>
        </div>
      );

    case "table":
      return (
        <div className="infographic-section">
          <div className="infographic-section-icon">{TABLE_ICON}</div>
          <div className="infographic-section-body infographic-table-wrap">
            <h4>{block.heading}</h4>
            <table>
              <caption>{block.heading}</caption>
              <thead>
                <tr>
                  {block.columns.map((col, i) => (
                    <th key={i} scope="col">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );

    case "compare":
      return (
        <div className="infographic-section">
          <div className="infographic-section-icon">{COMPARE_ICON}</div>
          <div className="infographic-section-body">
            <h4>{block.heading}</h4>
            <div className="infographic-compare-body">
              {[block.left, block.right].map((col, i) => (
                <div className="infographic-compare-col" key={i}>
                  <h5>{col.label}</h5>
                  <ul aria-label={col.label}>
                    {col.points.map((point, j) => (
                      <li key={j}>{point}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>
      );

    case "steps":
      return (
        <div className="infographic-section">
          <div className="infographic-section-icon">{STEPS_ICON}</div>
          <div className="infographic-section-body">
            <h4>{block.heading}</h4>
            <ol className="infographic-steps-list">
              {block.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ol>
          </div>
        </div>
      );

    default:
      return null;
```

- [ ] **Step 2: Add CSS for the four new block types**

In `src/index.css`, insert the following after the CSS added in Task 7's Step 2 (i.e. still before `.page-break`):

```css
.infographic-timeline-track {
  display: flex;
  align-items: flex-start;
  gap: 0;
  margin-top: 0.3rem;
}

.infographic-timeline-step {
  flex: 1;
  text-align: center;
  position: relative;
}

.infographic-timeline-step::before {
  content: "";
  position: absolute;
  top: 6px;
  left: -50%;
  width: 100%;
  height: 2px;
  background: var(--border-strong);
  z-index: 0;
}

.infographic-timeline-step:first-child::before {
  display: none;
}

.infographic-timeline-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--accent);
  border: 3px solid var(--surface);
  box-shadow: 0 0 0 1px var(--border-strong);
  margin: 0 auto 8px;
  position: relative;
  z-index: 1;
}

.infographic-timeline-step b {
  display: block;
  font-size: 0.8rem;
  font-weight: 600;
}

.infographic-timeline-caption {
  margin: 0.8rem 0 0;
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.infographic-table-wrap {
  overflow-x: auto;
}

.infographic-table-wrap table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.83rem;
  margin-top: 0.2rem;
}

.infographic-table-wrap th,
.infographic-table-wrap td {
  padding: 0.4rem 0.55rem;
  text-align: left;
  border-bottom: 1px solid var(--border-soft);
  vertical-align: top;
}

.infographic-table-wrap th {
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 0.72rem;
  background: var(--surface-raised);
}

.infographic-table-wrap tr:last-child td {
  border-bottom: none;
}

.infographic-table-wrap caption {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.infographic-compare-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.infographic-compare-col {
  border-left: 1px solid var(--border-soft);
  padding-left: 0.9rem;
}

.infographic-compare-col:first-child {
  border-left: none;
  padding-left: 0;
}

.infographic-compare-col h5 {
  margin: 0 0 0.35rem;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-faint);
}

.infographic-compare-col ul {
  margin: 0;
  padding-left: 1rem;
  font-size: 0.82rem;
  color: var(--text-secondary);
  line-height: 1.55;
}

.infographic-steps-list {
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: infographic-step;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.infographic-steps-list li {
  counter-increment: infographic-step;
  display: flex;
  gap: 0.7rem;
  font-size: 0.85rem;
  color: var(--text-secondary);
  line-height: 1.5;
}

.infographic-steps-list li::before {
  content: counter(infographic-step);
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 0.72rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

@media (max-width: 520px) {
  .infographic-compare-body {
    grid-template-columns: 1fr;
  }
  .infographic-compare-col {
    border-left: none;
    padding-left: 0;
  }
}

@media print {
  .infographic-table-wrap,
  .infographic-compare-body,
  .infographic-steps-list {
    break-inside: avoid;
  }
}
```

- [ ] **Step 2: Manual verification**

Run: `npm run dev`. In the browser devtools console, on the same deck used in Task 7 (replacing `<deckId>`):

```js
const db = await import('/src/db/db.ts');
await db.saveInfographic({
  id: 'fixture-structured-blocks',
  deckId: '<deckId>',
  title: 'Block Fixture — Structured Types',
  detail: 'detailed',
  blocks: [
    { type: 'timeline', icon: 'clock', heading: 'Interval Growth', steps: [{ label: '1d' }, { label: '3d' }, { label: '7d' }], caption: "Each Good multiplies by the card's ease factor." },
    { type: 'table', heading: 'Grading Changes the Ease Factor', columns: ['Grade', 'Ease', 'Next interval'], rows: [['Again', '-0.20', 'Resets to 1 day'], ['Good', '+0.00', '× ease factor']] },
    { type: 'compare', heading: 'Reviewing Too Early vs. Too Late', left: { label: 'Too early', points: ['Wastes a review'] }, right: { label: 'Too late', points: ['Card may be forgotten'] } },
    { type: 'steps', heading: 'How Grading Works', items: ['See the card', 'Rate it', 'Ease adjusts', 'Next interval scheduled'] },
  ],
  cardIds: [],
  createdAt: Date.now(),
});
```

Since this still isn't wired into `InfographicView` until Task 9, confirm the same way as Task 7: no console errors from the save, and the new CSS classes parse:

Run: `document.styleSheets.length > 0 && [...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => r.selectorText === '.infographic-steps-list') } catch { return false } })`
Expected: `true`.

Leave `fixture-structured-blocks` saved — Task 9's manual check reuses it, alongside `fixture-simple-blocks` from Task 7.

- [ ] **Step 3: Commit**

```bash
git add src/components/infographic/blocks.tsx src/index.css
git commit -m "$(cat <<'EOF'
Add block renderers for timeline/table/compare/steps

Completes InfographicBlockCard's eight-type switch. Table gets a
visually-hidden caption and scoped headers, compare's two columns
get an aria-label each, and steps renders as a real <ol> — the
first genuinely ordered content this feature has.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Wire `InfographicView`/`InfographicList` to the block dispatch

**Files:**
- Modify: `src/components/infographic/InfographicView.tsx`
- Modify: `src/components/infographic/InfographicList.tsx`

**Interfaces:**
- Consumes: `InfographicBlockCard` (Tasks 7-8), `Infographic.blocks` (Task 1).
- Produces: no change to either component's props — `InfographicMode.tsx` needs no changes for this task.

- [ ] **Step 1: `InfographicView.tsx` — dispatch to `InfographicBlockCard`, page-break every 3 blocks**

Replace the import line:

```tsx
import { INFOGRAPHIC_ICONS } from "./icons";
```

with:

```tsx
import InfographicBlockCard from "./blocks";
```

Replace the whole `<div className="infographic-sections">...</div>` block with:

```tsx
        <div className="infographic-sections">
          {infographic.blocks.map((block, index) => (
            <div key={index}>
              {index > 0 && index % 3 === 0 && (
                <div className="page-break">Page {Math.floor(index / 3) + 1}</div>
              )}
              <InfographicBlockCard block={block} />
            </div>
          ))}
        </div>
```

(Leave `handleDelete`/`confirm(...)` exactly as they are — that changes in Task 10, not here.)

- [ ] **Step 2: `InfographicList.tsx` — count blocks, not sections**

Change:

```tsx
            {infographic.sections.length} section{infographic.sections.length === 1 ? "" : "s"} ·{" "}
```

to:

```tsx
            {infographic.blocks.length} section{infographic.blocks.length === 1 ? "" : "s"} ·{" "}
```

(User-facing wording stays "section" — that's the reader's term for "one piece of the document," regardless of which internal block type it is; only the count's source field changes.)

- [ ] **Step 3: Manual verification**

Run: `npm run dev`, navigate to the deck used in Tasks 7-8's fixtures. On its infographics **List** screen, confirm:
- Both `fixture-simple-blocks` (5 blocks) and `fixture-structured-blocks` (4 blocks) show the correct block count in their meta line.

Open `fixture-simple-blocks`. Confirm all five blocks render: a bullets card, a warning callout (red left border), an info callout (indigo left border), a stat tile (large "62 days"), and an italic quote with a large opening quotation mark.

Open `fixture-structured-blocks`. Confirm: a timeline with three connected dots labeled 1d/3d/7d and a caption beneath; a table with a header row and two data rows; a two-column compare with "Too early"/"Too late" headings; a numbered steps list with four items. Since this fixture has 4 blocks, no page-break divider should appear (the divider only appears starting at index 3, i.e. a 4th-or-later block whose index is a multiple of 3 — index 3 itself qualifies, so confirm a "Page 2" divider DOES appear right before the 4th block, "How Grading Works").

Run: `npx tsc -b`
Expected: no errors in `InfographicView.tsx` or `InfographicList.tsx` (other files may still error until Task 10 — see Task 4's note; after this task, `InfographicList.tsx`'s `confirm(...)` calls are the only remaining `.sections`-era code, and those don't reference the old field, so `tsc -b` should in fact be fully clean at this point. If it isn't, the error will name the exact remaining `.sections` reference to fix.)

- [ ] **Step 4: Commit**

```bash
git add src/components/infographic/InfographicView.tsx src/components/infographic/InfographicList.tsx
git commit -m "$(cat <<'EOF'
Render infographics from blocks instead of sections

InfographicView now dispatches each block to InfographicBlockCard;
InfographicList counts blocks for its "N sections" meta line. Delete
confirmations are unchanged in this commit — see the next one.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Delete confirmations move onto `Modal`

**Files:**
- Modify: `src/components/infographic/InfographicList.tsx`
- Modify: `src/components/infographic/InfographicView.tsx`

**Interfaces:**
- Consumes: `Modal` (`src/components/ui/Modal.tsx`, unchanged), `deleteInfographicModalCopy` (Task 6).
- Produces: no prop changes to either component — `InfographicMode.tsx` needs no changes.

- [ ] **Step 1: `InfographicList.tsx` — replace `confirm()` with `Modal`**

Replace the whole file:

```tsx
import { useState } from "react";
import type { Infographic } from "../../types";
import { deleteInfographicModalCopy } from "../../lib/infographicCopy";
import Modal from "../ui/Modal";

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
  const [deleting, setDeleting] = useState<Infographic | null>(null);
  const copy = deleting ? deleteInfographicModalCopy(deleting.title) : null;

  const confirmDelete = () => {
    if (deleting) onDelete(deleting.id);
    setDeleting(null);
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
            {infographic.blocks.length} section{infographic.blocks.length === 1 ? "" : "s"} ·{" "}
            {infographic.cardIds.length} card{infographic.cardIds.length === 1 ? "" : "s"} ·{" "}
            {new Date(infographic.createdAt).toLocaleDateString()}
          </p>
          <div className="infographic-card-actions">
            <button type="button" className="btn-view" onClick={() => onView(infographic)}>
              View
            </button>
            <button type="button" className="btn-delete" onClick={() => setDeleting(infographic)}>
              Delete
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="new-infographic-card" onClick={onCreate}>
        + Create infographic
      </button>

      <Modal open={!!deleting} onClose={() => setDeleting(null)} labelledBy="delete-infographic-title" danger>
        <div className="dialog-head">
          <div className="dialog-title-row">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 7c4.5 8 8 8 8.5 8s3-6 7.5-8" />
            </svg>
            <h2 id="delete-infographic-title">{copy?.title}</h2>
          </div>
          <button type="button" className="icon-btn" title="Cancel" aria-label="Cancel" onClick={() => setDeleting(null)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <p className="body-text">{copy?.body}</p>
        <div className="dialog-actions">
          <button type="button" className="ghost-btn" onClick={() => setDeleting(null)}>
            Cancel
          </button>
          <button type="button" className="btn-danger-solid" onClick={confirmDelete}>
            Delete infographic
          </button>
        </div>
      </Modal>
    </div>
  );
}
```

- [ ] **Step 2: `InfographicView.tsx` — replace `confirm()` with `Modal`**

Replace the whole file:

```tsx
import { useState } from "react";
import type { Infographic } from "../../types";
import InfographicBlockCard from "./blocks";
import { deleteInfographicModalCopy } from "../../lib/infographicCopy";
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
 * One saved infographic in full: title, then every block in its own card.
 *
 * The dashed page-break divider every 3 blocks is presentational only —
 * see the spec's "Pagination is presentation, not data" note. Nothing about
 * where a block actually falls on a page is stored; this is purely a
 * visual cue that content of this length would run to more than one page.
 */
export default function InfographicView({ infographic, totalCardCount, onBack, onDelete }: Props) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const copy = deleteInfographicModalCopy(infographic.title);
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
          {infographic.blocks.map((block, index) => (
            <div key={index}>
              {index > 0 && index % 3 === 0 && (
                <div className="page-break">Page {Math.floor(index / 3) + 1}</div>
              )}
              <InfographicBlockCard block={block} />
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

Note both dialogs share the same `id="delete-infographic-title"` — harmless, since `InfographicList` and `InfographicView` are never both mounted at once (`InfographicMode`'s phase machine shows exactly one at a time).

- [ ] **Step 3: Manual verification**

Run: `npm run dev`. On the List screen, click "Delete" on `fixture-simple-blocks`. Confirm: a real dialog appears (not a browser-native `confirm()`), titled `Delete "Block Fixture — Simple Types"?`, body `This can't be undone.`, with Cancel and a red "Delete infographic" button — visually and behaviorally identical to the folder-delete dialog (compare side-by-side with Deck Manager's own folder delete). Confirm Escape closes it, clicking the scrim closes it, and clicking "Delete infographic" actually removes the row and returns to the list. Repeat from the View screen with `fixture-structured-blocks`, using its own "Delete this infographic" button.

- [ ] **Step 4: Commit**

```bash
git add src/components/infographic/InfographicList.tsx src/components/infographic/InfographicView.tsx
git commit -m "$(cat <<'EOF'
Move infographic delete confirmations onto the shared Modal

Both InfographicList and InfographicView now show the same Modal
dialog the folder-delete flow uses, instead of window.confirm.
Modal.tsx itself is unchanged — it was already generic enough for
this, with exactly one prior consumer (DeckLibrary's folder dialogs).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Final integration pass

**Files:** none (verification only).

- [ ] **Step 1: Full type-check**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 2: Pure-logic tests**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-infographic.mjs`
Expected: `All passed.`, exit code 0.

- [ ] **Step 3: IndexedDB integration check**

```bash
npm run dev &
node tools/idb-collector.cjs result.txt &
chrome --headless=new --user-data-dir=/tmp/idb-final-$$ http://localhost:5199/tools/idb-check.html
cat result.txt
```

Expected: `RESULT: ALL PASSED` (adjust the port/flags to match how `tools/idb-check.html`'s own header comment says to run it, if `npm run dev`'s port differs from the `vite --port 5199 --strictPort` it expects).

- [ ] **Step 4: No stale references**

Run: `grep -rn "\.sections\b" src/components/infographic src/lib/infographicGenerator.ts src/lib/infographicPrompt.ts src/types.ts`
Expected: no output.

- [ ] **Step 5: Full manual walkthrough**

Using a deck with real cards and a configured AI key (hosted or BYOK):
1. Deck Manager → "Create infographic" → Setup screen.
2. Generate at **Basic**: confirm it reads as 2-3 blocks, mostly bullets.
3. Generate at **Standard**: confirm a mix of block types appears, not just bullets.
4. Generate at **Detailed**: confirm up to 10 blocks, with no more than 1 stat, 1 compare, or 2 tables.
5. From the List screen, delete one via the Modal dialog; confirm it's gone.
6. Delete the two remaining fixtures (`fixture-simple-blocks`, `fixture-structured-blocks`) left over from Tasks 7-9's manual checks, via the same Modal flow — they were dev-only fixtures, not meant to stay.

- [ ] **Step 6: Commit (if Step 5 required any fixes)**

If every check above already passed with no changes, there is nothing to commit for this task. Otherwise:

```bash
git add -A
git commit -m "$(cat <<'EOF'
Fix integration issues found in the final pass

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
