# Infographic Block Schema — Design

**Goal:** Replace the infographic's single block type (`bullets`-only sections) with eight, so the generated document can hold a table, a timeline, a numbered process, a two-sided comparison, a highlighted stat, a pulled quote, and a warning callout — not just icon-and-bullet cards, repeated. Same trust model as the original design (`2026-09-13-flashcard-infographic-design.md`): the model still returns structured JSON, the app still renders it through layout/CSS it owns, never the model's own markup. This spec only changes *what the JSON can describe*, not who renders it or how.

**Scope in one line:** grow `InfographicSection` into a discriminated `InfographicBlock` union, resolve the two risks that come with changing a stored shape (old records, and per-block validation), and give the model a rule for when to reach for each block type instead of defaulting to bullets every time.

**Mockup:** built and approved in-conversation as the "Structured vs. Sandboxed" comparison artifact, rendered in the app's real tokens (Inter, `--accent`, the existing flat card/border conventions) rather than an invented style — same relationship the original spec had to its own mockup.

## Decisions (confirmed 2026-09-15)

| Question | Decision | Why |
|---|---|---|
| Old records, once the shape changes | **Normalize at read time, no DB migration.** `Infographic` gains `blocks: InfographicBlock[]`; a `normalizeInfographicBlocks(infographic)` helper returns `blocks` if present, otherwise maps legacy `sections` into `[{ type: 'bullets', ... }]`. `InfographicView` calls the helper, never reads `sections` directly. | `DB_VERSION` bumps in this app have only ever added stores/indexes (`db.ts`'s `oldVersion < n` blocks), never rewritten existing rows. Adding that machinery for one field rename is more risk than a three-line normalizer at read time, and it works retroactively on rows already sitting in a user's IndexedDB without touching storage code at all. |
| Icon choice, for the four new block types | **Fixed in code, not model-chosen.** `table`, `callout`, `stat`, `compare`, `steps`, and `quote` carry no `icon` field at all — the renderer picks one fixed icon per type. Only `bullets` and `timeline` keep the model-chosen `icon: InfographicIcon` field the original 12-name enum already defines. | Six of eight types never had a reason to vary their icon in the mockup — a table always reads as a table. Dropping the field removes an entire validation/fallback surface (nothing to check, nothing that can come back invalid) for most of the schema, and keeps the closed-enum discipline where it actually earns its keep: `bullets` and `timeline` cover open-ended content a single fixed icon wouldn't fit. |
| `quote` content | **Must be a verbatim substring of a source card**, checked at parse time (case/whitespace-normalized). A quote that doesn't match any card's front or back text is dropped, silently, the same way an unrecognized icon used to fall back rather than fail the whole response. | A literal quotation mark tells the reader "this is what the card said." A paraphrased or invented `quote` block would misrepresent the deck's own content — the one block type where hallucination has a visible, wrong-looking failure mode (a quotation mark around words nobody wrote), so it gets the one content-level check none of the other seven blocks need. |
| How many blocks, total | **A per-level ceiling on block *count*, plus a combined cap on the "dense" types.** Basic: 3 blocks. Standard: 6. Detailed: 10 — at most 1 `stat`, at most 1 `compare`, at most 2 `table` among them at any level. | Mirrors how the original spec already ceilings sections/points rather than trusting the model's sense of "enough" — extended to block *type mix*, not just count, so Detailed can't turn into ten tables back to back. |
| Prompt guidance for picking a block type | **A short, explicit rubric in each level's system prompt**, not left to the model's judgement from the type names alone. | With one block type there was no ambiguity to resolve. With eight, an ungrounded model defaults to what it already knows works — bullets — and the schema's added a lot of surface for no visible change in output. Naming the rubric prevents that flatly. |

## Data model

`src/types.ts` — `InfographicSection` becomes one variant of a new union; `Infographic` and `LlmInfographic` swap `sections` for `blocks`. The four new interfaces are additive, nothing existing is deleted (old stored rows keep whatever `sections` they already have — see the migration decision above).

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

`Infographic` and `LlmInfographic` (both in `src/types.ts`): `sections: InfographicSection[]` → `blocks: InfographicBlock[]`. `InfographicSection` itself stays exported, unchanged, purely so the normalizer and any code still touching a raw legacy row have a name for the old shape to map from.

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
| `quote` | 200 chars, and must verbatim-match a source card (see Decisions) | all levels |
| Total blocks | 3 / 6 / 10 (basic/standard/detailed) | — |
| `stat` + `compare` + `table` combined | at most 1 + 1 + 2 | all levels |

Same posture as the original: clamp, don't reject. A block over a ceiling gets truncated (extra table rows/columns dropped, extra chars trimmed with an ellipsis); a block that can't be salvaged (e.g. a `table` with zero columns) is dropped from the array, the way a zero-point section already is today. The response as a whole still only returns `null` when no usable blocks survive at all.

## Generation: prompt and parser changes

- **`src/lib/infographicPrompt.ts`**: each of the three `INFOGRAPHIC_SYSTEM_PROMPTS` entries gains the block-type rubric — one sentence per type telling the model when it applies, e.g. *"`stat` — one standout number worth calling out on its own, not a list of several. `compare` — exactly two things being weighed against each other, never more. `timeline` — steps that each have a real time/interval label; use `steps` instead when the sequence has no time attached. `quote` — copy the exact wording from a card; never paraphrase into it."* Basic's prompt keeps the rubric short (it only ever needs `bullets` and maybe one `stat`); Detailed's spells out all eight.
- `parseInfographicResponse` gains one `switch (block.type)` validation arm per block type (shape check + clamp, per the table above), replacing the single per-section check it has today. Unrecognized `type` values are dropped, the same treatment an unrecognized `icon` already gets.
- The quote verbatim check needs the source cards' text in scope at parse time — `parseInfographicResponse`'s signature grows one parameter, the same `Flashcard[]` (or just their front/back strings) `infographicGenerator.ts` already has on hand when it calls the parser.
- **Token budget** (`src/lib/aiTransport.ts`, `src/server/generateHandler.ts`): the three `infographic-*` `MAX_TOKENS` entries move from a flat 4000 to 4000 / 6000 / 8000 (basic/standard/detailed) — a `table` or `compare` block's nested arrays cost meaningfully more JSON per block than a bullets section did, and Detailed can now carry up to 10 of them.

## Rendering: `src/components/infographic/`

- `InfographicView.tsx` gets one small presentational component per block type (`BulletsCard`, `TimelineCard`, `TableCard`, `CalloutCard`, `StatCard`, `CompareCard`, `StepsCard`, `QuoteCard`), dispatched from a `block.type` switch — same shape as the icon lookup it already does today, one level up.
- Fixed icons for the six model-doesn't-choose types live next to the switch, not in `icons.tsx` (that file stays exactly what it is today: the 12-name `InfographicIcon` enum's SVGs, still only spent on `bullets`/`timeline`).
- Accessibility, resolved per block rather than left to the visual mockup: `TableCard` renders a `<caption>` (visually hidden, text = the block's `heading`) and real `<th scope="col">`; `CompareCard`'s two columns get an `<h4>` or `aria-label` from `left.label`/`right.label`, not just styling; `StatCard`'s wrapper gets `aria-label="{value}{unit}: {caption}"` so the large number doesn't read as a bare figure; `StepsCard` renders an `<ol>` (already true of nothing today — `bullets` uses `<ul>`, `steps` is the first genuinely ordered content this feature has).
- `normalizeInfographicBlocks` (new, small, colocated with the other pure helpers in `src/lib/infographicPrompt.ts` or a new `src/lib/infographicBlocks.ts` if that file gets crowded) is the single place old-shape and new-shape records converge — `InfographicView` is the only caller, so a legacy record and a fresh one are indistinguishable by the time rendering sees them.

## What does not change

- Still no `dangerouslySetInnerHTML`, no iframe, no markup crossing from the model into the DOM — every block is a typed props object into a typed component, exactly the posture the original spec chose.
- Still no print/export path (confirmed absent in the current codebase, not assumed) — `TableCard`/`CompareCard`/`StepsCard` get `break-inside: avoid` in their CSS now, while it's free, in case that changes later; nothing else print-related is in scope.
- Storage layer (`db.ts`), the four screens (List/Setup/Generating/View), routing, AI gating, and the "many infographics per deck, no staleness tracking" decisions from the original spec — all unchanged.
- The 12-name `InfographicIcon` enum itself — unchanged, just narrower in where it's used.

## Verification

Extends `tools/test-infographic.mjs` (from the original spec) with one case per new decision, not a rewrite:

- Per-block clamping at each ceiling in the table above (table over 4 columns/6 rows, callout over 220 chars, etc.).
- Total-block-count ceiling per level, and the combined `stat`+`compare`+`table` cap, each pushed one over to confirm the *last* offending block is what's dropped, not an arbitrary one.
- A `quote` whose text doesn't appear in any source card is dropped; one that does (after whitespace/case normalization) survives.
- An unrecognized `block.type` is dropped without affecting sibling blocks.
- `normalizeInfographicBlocks` on a legacy `{ sections: [...] }` record produces the expected `[{ type: 'bullets', ... }]` array, and on a record that already has `blocks` returns it untouched.
- A response with zero surviving blocks still returns `null` from `parseInfographicResponse`, matching the original all-dropped behavior.
