# Modern Minimal Redesign — Design

**Goal:** Replace the app's current warm, dark-only visual identity (Fraunces/Source Serif serif pairing, ink/panel palette, gold accent) with a modern-minimal system — single sans-serif family, neutral zinc scale, one warm-indigo accent, tighter radii, border-based elevation in light mode — implemented as both a light and a dark theme with a user-facing toggle. Approved direction and exact token values come from the mockup canvas built during brainstorming: https://claude.ai/code/artifact/9554dcc3-3a60-4e77-8230-099f6a668f91 (six screens: Deck Library, Study, Quiz Setup, Quiz Question, Upload, Review).

This is a presentation-layer and one-small-feature (theme toggle) change. No route, data model, storage schema, AI generation logic, or component prop interface changes.

## Token architecture

`src/index.css` currently defines one hardcoded dark palette on `:root` (`--ink`, `--panel`, `--accent`, `--calm`, `--warm`, etc.) and forces `color-scheme: dark`. This is replaced with a two-block token set:

- `:root` — light theme values (the base/default).
- `:root[data-theme="dark"]` — dark theme overrides, same variable names.

Token names (values below are the mockup's resolved colors):

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#fafafa` | `#0a0a0c` |
| `--surface` | `#ffffff` | `#18181b` |
| `--surface-raised` | `#f4f4f5` | `#212126` |
| `--border` | `#e4e4e7` | `#2a2a30` |
| `--border-strong` | `#d4d4d8` | `#3f3f46` |
| `--text` | `#18181b` | `#f4f4f5` |
| `--text-secondary` | `#71717a` | `#a1a1aa` |
| `--text-faint` | `#a1a1aa` | `#71717a` |
| `--accent` | `#5b52d6` | `#8b87f0` |
| `--accent-soft` | `rgba(91,82,214,0.08)` | `rgba(139,135,240,0.16)` |
| `--accent-contrast` | `#ffffff` | `#0a0a0c` |
| `--success` | `#1a8f5e` | `#6bc79b` |
| `--success-soft` | `rgba(26,143,94,0.08)` | `rgba(107,199,155,0.14)` |
| `--warning` | `#b6650a` | `#e0a458` |
| `--warning-soft` | `rgba(182,101,10,0.08)` | `rgba(224,164,88,0.14)` |
| `--shadow` | `0 1px 2px rgba(0,0,0,0.04)` | `0 8px 24px rgba(0,0,0,0.45)` |

`--success`/`--warning` replace the old `--calm`/`--warm` semantic pair (used today for study tallies, "knew it"/"still learning" buttons, quiz correct/missed verdicts, and source-type tags) — same role, new hues to match the accent family.

`color-scheme` is set per-theme (`light` under `:root`, `dark` under `:root[data-theme="dark"]`) so native form controls and scrollbars match.

## Theme resolution and persistence

New file `src/lib/theme.ts`:
- `type Theme = 'light' | 'dark'`
- `getStoredTheme(): Theme | null` — reads `localStorage['flashcard-forge:theme']`.
- `resolveInitialTheme(): Theme` — stored value if present, else `window.matchMedia('(prefers-color-scheme: dark)')`, else `'light'`.
- `applyTheme(theme: Theme): void` — sets `document.documentElement.dataset.theme` and writes to `localStorage`.

`index.html` gets a small inline `<script>` in `<head>` (before any stylesheet) that resolves and stamps `data-theme` on `<html>` synchronously, using the same logic as `resolveInitialTheme` (duplicated inline, not imported — it must run before the module graph loads) — this avoids a flash of the wrong theme on load. It stays intentionally tiny (read localStorage, else `matchMedia`, set attribute).

New component `src/components/ui/ThemeToggle.tsx`: a small segmented control (sun / moon icon buttons, matching the mockup's `.theme-toggle`) that calls `applyTheme` and updates its own active-icon state from `document.documentElement.dataset.theme` on mount. Rendered in `App.tsx`'s `<header className="top-bar">`, to the right of the back-to-library button.

## Typography

`index.html`'s Google Fonts `<link>` changes from the current Fraunces + Source Serif 4 + IBM Plex Sans set to Inter only (weights 400/500/600/700). `index.css` collapses `--font-display`, `--font-read`, `--font-ui` into a single `--font-ui: 'Inter', system-ui, -apple-system, sans-serif` used everywhere (headings, body, card faces, quiz text). The monospace stack for code snippets (`.card-code code`) is untouched — that is a functional choice (reading real syntax), not part of the display/body pairing being replaced.

## Shape and elevation

- Radii: cards, buttons, inputs, textareas move from the current mixed 7–18px set down to a consistent 8px (buttons/inputs) / 10px (cards, panels). Pills (`.source-tag`, `.mode-chip`, `.topic-chip`, tally/progress) keep `border-radius: 100px`.
- Elevation: `box-shadow` on cards/panels is replaced by `var(--shadow)`, which is near-invisible in light mode (relying on the `1px solid var(--border)` for definition) and a real soft shadow in dark mode. The decorative double radial-gradient wash on `body` (`background-image` in the current `:root`/`body` rules) is removed in favor of a flat `var(--bg)` — that texture was part of the warm-ink identity being replaced, not a functional element.

## Component-level changes (all within `src/index.css`, class names unchanged)

Every existing class stays — only the property values change (colors → tokens, radii, shadows, and the button/input/border patterns below). No component's JSX needs new classes except where noted in "Icon replacements."

- **Buttons** (`.primary-btn`, `.secondary-btn`, `.ghost-btn`, `.icon-btn`, `.mode-chip`): solid accent fill for primary, bordered neutral for secondary, transparent/text for ghost — same structure as today, recolored to the new tokens; `.secondary-btn.learning` / `.secondary-btn.knew` map to `--warning`/`--success`.
- **Deck cards / library** (`.deck-card`, `.source-tag`, `.empty-state`, `.deck-grid`): border-first card, `--shadow` for the light lift on hover instead of the current heavier `box-shadow`.
- **Dropzone / uploader** (`.dropzone`, `.dropzone-icon`, `.chalk-spinner`): dashed `var(--border-strong)`, accent on hover/drag, spinner recolored via existing `var(--accent)` reference (already token-driven, just picks up new value).
- **Form fields** (`input[type="text"]`, `.deck-name-row input`, `textarea`, `.url-input`): `var(--surface)` background, `var(--border)` border, `var(--accent)` focus ring — same rules, new tokens.
- **Candidate / manager rows** (`.candidate-row`, `.candidate-front`, `.candidate-back`, `.source-label`): unchanged structure; `.source-label.status-known`/`status-unknown` map to `--success`/`--warning`.
- **Study screen** (`.tally-board`, `.tally-label.knew`/`.learning`, `.progress-fill`, `.flip-card-face`, `.topic-chip`, `.face-tag`): tally colors map to `--success`/`--warning`; flip card faces become bordered `var(--surface)`/`var(--surface-raised)` panels with `var(--shadow)` instead of the current heavier card shadow; topic chip becomes the pill style shown in the mockup (`--accent-soft` background, `--accent` text).
- **Quiz** (`.quiz-style-option`, `.quiz-option`, `.quiz-option-key`, `.quiz-review-row`, `.quiz-verdict`): selection state uses `--accent`/`--accent-soft` (already the pattern today); `.quiz-review-row` correct/missed left-border stripe maps to `--success`/`--warning`.
- **AI notices** (`.ai-notice.failed`/`.partial`, `.drafting-banner`): `--warning-soft`/`--accent-soft` backgrounds, same structure.
- **Responsive and reduced-motion blocks**: kept as-is structurally; any hardcoded colors inside them (there are none currently — they're layout-only) stay that way.

## Icon replacements

Per the approved mockups, dingbat/emoji glyphs used as icons are replaced with small inline SVGs (stroke `currentColor`, 14–16px, 1.8–2px stroke width, matching the mockup's icon style). Only these spots change (text content/props/behavior unchanged, JSX structure otherwise untouched):

- `src/components/DeckLibrary.tsx`: the `✕` delete-deck glyph and the `✎` empty-state `chalk-doodle` glyph → SVG (x-icon; a simple document/spark icon for the empty state).
- `src/components/DeckManager.tsx`: the `✕` delete-card glyph → SVG x-icon. The `"Copied ✓"` label becomes `"Copied"` next to a small SVG check, rather than the Unicode glyph.
- `src/components/CandidateReview.tsx`: the `✕` remove-candidate glyph → SVG x-icon.
- `src/components/quiz/QuizResults.tsx`: the `✓`/`✕` verdict glyphs → SVG check-circle / x-circle icons.
- `src/components/Uploader.tsx`: the `⤒` dropzone glyph → SVG upload-arrow icon (matches the mockup).
- `src/App.tsx`: the brand mark's hand-drawn chalk-stroke SVG is replaced with the mockup's stacked-cards mark, shown on a small solid `var(--accent)` badge (white strokes) rather than bare accent-colored strokes on transparent. The `← Back to library` button's literal arrow character becomes an SVG chevron-left ahead of the text.

A single small icon set (a handful of inline SVG snippets: x, check, upload-arrow, chevron-left, sun, moon, stacked-cards) is used across these files — defined locally where used (no new shared icon library/dependency, consistent with the project's existing style of small focused files).

## Non-goals

- No changes to routing, IndexedDB schema, AI generation/prompting, quiz selection logic, or any component's props/behavior beyond the icon swaps and the new toggle.
- No new dependencies (Inter loads the same way the current fonts do, via the existing Google Fonts `<link>` pattern; icons are hand-written inline SVG, not an icon package).
- No layout/information-architecture changes — every screen keeps its current structure, copy, and interaction flow; this is a re-skin plus a theme toggle, not a UX overhaul.
- No change to the existing 640px responsive breakpoint or the reduced-motion handling, beyond whatever token values they reference.

## Verification

- `npx tsc -b` and `npm run build` must both succeed.
- Manual check with `npm run dev`: click through Library → Upload → Review → Manage → Study → Test in both light and dark (via the new toggle), confirm text contrast and hover/selected states read clearly in both, confirm the flip card, quiz option selection, and progress bar still animate correctly, confirm the 640px responsive layout and `prefers-reduced-motion` behavior are unaffected.
- No automated test suite exists in this project (`package.json` has no `test` script) — verification is `tsc`/`build` plus the manual pass above, consistent with how this repo has verified prior UI-only changes.
