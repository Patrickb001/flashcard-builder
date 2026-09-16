# Infographic Block Schema — Design

**Goal:** Replace the infographic's single block type (`bullets`-only sections) with eight, so the generated document can hold a table, a timeline, a numbered process, a two-sided comparison, a highlighted stat, a pulled quote, and a warning callout — not just icon-and-bullet cards, repeated. Same trust model as the original design (`2026-09-13-flashcard-infographic-design.md`): the model still returns structured JSON, the app still renders it through layout/CSS it owns, never the model's own markup. This spec only changes *what the JSON can describe*, not who renders it or how.

**Scope in one line:** grow `InfographicSection` into a discriminated `InfographicBlock` union, give the model a rule for when to reach for each block type instead of defaulting to bullets every time, and bring the feature's delete confirmations onto the app's shared modal instead of `window.confirm`.

**Mockup:** built and approved in-conversation as the "Structured vs. Sandboxed" comparison artifact, rendered in the app's real tokens (Inter, `--accent`, the existing flat card/border conventions) rather than an invented style — same relationship the original spec had to its own mockup.

## Decisions (confirmed 2026-09-15, revised same day after review)

| Question | Decision | Why |
|---|---|---|
| Old records, once the shape changes | **Nothing to migrate — the feature hasn't shipped yet.** No record with the old `sections` shape is expected to exist. As a safety net, not a migration path: if `InfographicMode` ever loads a row whose `blocks` isn't a valid array, it deletes that row on the spot rather than trying to render or convert it. | No users have generated an infographic under the old shape, so there is nothing to preserve. A silent cleanup-on-load is simpler than a normalizer that exists to handle data that shouldn't be there. |
| Icon choice, for the four new block types | **Fixed in code, not model-chosen.** `table`, `callout`, `stat`, `compare`, `steps`, and `quote` carry no `icon` field at all — the renderer picks one fixed icon per type. Only `bullets` and `timeline` keep the model-chosen `icon: InfographicIcon` field the original 12-name enum already defines. | Six of eight types never had a reason to vary their icon in the mockup — a table always reads as a table. Dropping the field removes an entire validation/fallback surface for most of the schema, and keeps the closed-enum discipline where it earns its keep: `bullets` and `timeline` cover open-ended content a single fixed icon wouldn't fit. |
| `quote` content | **Accurate, not verbatim.** The model may reword a card's content for brevity or clarity as long as it stays true to what the card actually says — no fidelity check at parse time beyond the same length clamp every free-text block gets. | Requiring an exact substring match would reject a perfectly good, faithfully-reworded pull-quote just as readily as a fabricated one — it can't tell the two apart. Faithfulness here is a prompt instruction, the same way "don't restate a card's back verbatim as a bullet" already is for `bullets` today; it was never something parse-time string matching could actually verify. |
| How many blocks, total | **A per-level ceiling on block *count*, plus a combined cap on the "dense" types.** Basic: 3 blocks. Standard: 6. Detailed: 10 — at most 1 `stat`, at most 1 `compare`, at most 2 `table` among them at any level. | Mirrors how the original spec already ceilings sections/points rather than trusting the model's sense of "enough" — extended to block *type mix*, not just count, so Detailed can't turn into ten tables back to back. |
| Prompt guidance for picking a block type | **A short, explicit rubric in each level's system prompt**, not left to the model's judgement from the type names alone. | With one block type there was no ambiguity to resolve. With eight, an ungrounded model defaults to what it already knows works — bullets — and the schema's added a lot of surface for no visible change in output. Naming the rubric prevents that flatly. |
| Confirmation prompts (e.g. "Delete this infographic?") | **The app's existing `Modal` primitive** (`src/components/ui/Modal.tsx`), not `window.confirm`. Turns out this doesn't need a new component: the folder feature already generalized its create/delete dialogs into a real reusable `Modal` — `danger`/`labelledBy`/`open`/`onClose` props, portal, focus trap, Escape handling, all already built — and today it has exactly one consumer (`DeckLibrary.tsx`'s two folder dialogs). Infographic's delete confirmations become its second. | `window.confirm` is what the two infographic delete confirmations use today (`InfographicList.tsx`, `InfographicView.tsx`) — a plain browser dialog, unstyled, inconsistent with the folder-delete flow's real modal one screen over. Since a generic version already exists and was clearly built to be reused, the fix is routing to it, not building a second thing that does the same job. |

## Data model

`src/types.ts` — `InfographicSection` is retired outright (nothing needs to read the old shape, per the decision above); `Infographic` and `LlmInfographic` carry `blocks: InfographicBlock[]` in its place.

```ts
export type InfographicIcon =
  | 'book' | 'lightbulb' | 'brain' | 'chart' | 'list'
  | 'arrows' | 'target' | 'clock' | 'check' | 'warning'
  | 'network' | 'question';
// unchanged — still only spent on `bullets` and `timeline`, see Decisions above.

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

export interface QuoteBlock {
  type: 'quote';
  text: string;
}

export type InfographicBlock =
  | BulletsBlock | TimelineBlock | TableBlock | CalloutBlock
  | StatBlock | CompareBlock | StepsBlock | QuoteBlock;
```

`Infographic` and `LlmInfographic` (both in `src/types.ts`): `sections: InfographicSection[]` → `blocks: InfographicBlock[]`. Nothing else on either interface changes.

### Per-block clamps

Extends the existing per-level table (`2026-09-13` spec) rather than replacing it — sections/points ceilings still apply verbatim to `bullets` and now also bound `steps`' `items` and `compare`'s `points` per column:

| Block | Ceiling | Applies at |
|---|---|---|
| `bullets` / `steps` items, `compare` points/column | same as original points/section ceiling (4 / 5 / 6 for basic/standard/detailed) | all levels |
| `timeline` steps | 6 max, regardless of level | all levels |
| `table` | 4 columns max, 6 rows max, 60 chars/cell | all levels |
| `callout` | 220 chars | all levels |
| `stat` value | 12 chars (it's rendered large — "62 days" fits, a sentence doesn't) | all levels |
| `stat` caption | 140 chars | all levels |
| `quote` | 200 chars — no fidelity check beyond length, per the Decisions above | all levels |
| Total blocks | 3 / 6 / 10 (basic/standard/detailed) | — |
| `stat` + `compare` + `table` combined | at most 1 + 1 + 2 | all levels |

Same posture as the original: clamp, don't reject. A block over a ceiling gets truncated (extra table rows/columns dropped, extra chars trimmed with an ellipsis); a block that can't be salvaged (e.g. a `table` with zero columns) is dropped from the array, the way a zero-point section already is today. The response as a whole still only returns `null` when no usable blocks survive at all.

## Generation: prompt and parser changes

- **`src/lib/infographicPrompt.ts`**: each of the three `INFOGRAPHIC_SYSTEM_PROMPTS` entries gains the block-type rubric — one sentence per type telling the model when it applies, e.g. *"`stat` — one standout number worth calling out on its own, not a list of several. `compare` — exactly two things being weighed against each other, never more. `timeline` — steps that each have a real time/interval label; use `steps` instead when the sequence has no time attached. `quote` — pull the idea from one card; light rewording for clarity or brevity is fine, but never add a claim the card didn't make."* Basic's prompt keeps the rubric short (it only ever needs `bullets` and maybe one `stat`); Detailed's spells out all eight.
- `parseInfographicResponse` gains one `switch (block.type)` validation arm per block type (shape check + clamp, per the table above), replacing the single per-section check it has today. Unrecognized `type` values are dropped, the same treatment an unrecognized `icon` already gets. No new parameters needed — clamping is purely structural (lengths/counts), so the parser doesn't need the source cards in scope the way a verbatim check would have required.
- **Token budget** (`src/lib/aiTransport.ts`, `src/server/generateHandler.ts`): the three `infographic-*` `MAX_TOKENS` entries move from a flat 4000 to 4000 / 6000 / 8000 (basic/standard/detailed) — a `table` or `compare` block's nested arrays cost meaningfully more JSON per block than a bullets section did, and Detailed can now carry up to 10 of them.

## Rendering: `src/components/infographic/`

- `InfographicView.tsx` gets one small presentational component per block type (`BulletsCard`, `TimelineCard`, `TableCard`, `CalloutCard`, `StatCard`, `CompareCard`, `StepsCard`, `QuoteCard`), dispatched from a `block.type` switch — same shape as the icon lookup it already does today, one level up.
- Fixed icons for the six model-doesn't-choose types live next to the switch, not in `icons.tsx` (that file stays exactly what it is today: the 12-name `InfographicIcon` enum's SVGs, still only spent on `bullets`/`timeline`).
- Accessibility, resolved per block rather than left to the visual mockup: `TableCard` renders a `<caption>` (visually hidden, text = the block's `heading`) and real `<th scope="col">`; `CompareCard`'s two columns get an `<h4>` or `aria-label` from `left.label`/`right.label`, not just styling; `StatCard`'s wrapper gets `aria-label="{value}{unit}: {caption}"` so the large number doesn't read as a bare figure; `StepsCard` renders an `<ol>` (already true of nothing today — `bullets` uses `<ul>`, `steps` is the first genuinely ordered content this feature has).
- **Invalid-row cleanup**: `InfographicMode`'s existing mount effect (the one that already calls `getInfographicsForDeck`) filters the result — any row whose `blocks` is not an array gets passed to `deleteInfographic` and is excluded from what **List** renders. No separate migration step, no normalizer function; this is the "nothing to migrate, but clean up if something's there anyway" safety net from the Decisions table.

## Modals: infographic delete confirmations move onto `Modal`

- **`src/components/infographic/InfographicList.tsx`** and **`src/components/infographic/InfographicView.tsx`** replace their `confirm(...)` calls with the same `<Modal>` pattern the folder-delete dialog already uses (`DeckLibrary.tsx:569-592`): `<Modal open={...} onClose={...} labelledBy="delete-infographic-title" danger>` wrapping a `dialog-head`/`dialog-title-row` (icon + `<h2 id="delete-infographic-title">`), an `icon-btn` close button, a `body-text` paragraph, and `dialog-actions` with a `ghost-btn` (Cancel) and `btn-danger-solid` (Delete) — identical DOM shape and CSS classes, new copy only.
- A new pure helper, `deleteInfographicModalCopy(title: string)`, returns `{ title, body }` the same way `deleteFolderModalCopy(name, deckCount)` does today (`src/lib/deckFolders.ts:82-90`) — kept as a small pure function for the same testability reason, likely colocated in `src/lib/infographicPrompt.ts` or a new `src/lib/infographicCopy.ts` if that file's getting crowded.
- Both call sites already track the "which one am I about to delete" state locally (mirroring `deletingFolder` in `DeckLibrary.tsx`) — this is a swap of what renders the confirmation, not a change to either screen's delete flow otherwise.
- Out of scope: this does **not** touch `deckActions.ts`'s deck-delete `confirm()` or `QuizRunner.tsx`'s exit-quiz `confirm()` — both still bare `window.confirm`. Nothing in this feature requires changing them, and doing so wasn't asked for; `Modal` being genuinely reusable now makes that a clean, separate follow-up if it's ever wanted.

## What does not change

- Still no `dangerouslySetInnerHTML`, no iframe, no markup crossing from the model into the DOM — every block is a typed props object into a typed component, exactly the posture the original spec chose.
- Still no print/export path (confirmed absent in the current codebase, not assumed) — `TableCard`/`CompareCard`/`StepsCard` get `break-inside: avoid` in their CSS now, while it's free, in case that changes later; nothing else print-related is in scope.
- Storage layer (`db.ts`), the four screens (List/Setup/Generating/View), routing, AI gating, and the "many infographics per deck, no staleness tracking" decisions from the original spec — all unchanged.
- The 12-name `InfographicIcon` enum itself — unchanged, just narrower in where it's used.
- `Modal.tsx` itself — unchanged. It was already generic enough for this; the work is calling it from two new places; not modifying it.

## Verification

Extends `tools/test-infographic.mjs` (from the original spec) with one case per new decision, not a rewrite:

- Per-block clamping at each ceiling in the table above (table over 4 columns/6 rows, callout over 220 chars, etc.).
- Total-block-count ceiling per level, and the combined `stat`+`compare`+`table` cap, each pushed one over to confirm the *last* offending block is what's dropped, not an arbitrary one.
- An unrecognized `block.type` is dropped without affecting sibling blocks.
- A response with zero surviving blocks still returns `null` from `parseInfographicResponse`, matching the original all-dropped behavior.
- A stored row with an invalid/missing `blocks` array is deleted rather than rendered when `InfographicMode` loads the list — checked manually against the dev server (same category of check the original spec already uses for its other IndexedDB behavior, no headless-browser runner available here).
- The two delete-confirmation modals — manual check that `InfographicList`/`InfographicView`'s delete flow now shows the same `Modal` (Escape closes it, click-outside closes it, focus lands correctly) rather than a browser `confirm()`.
