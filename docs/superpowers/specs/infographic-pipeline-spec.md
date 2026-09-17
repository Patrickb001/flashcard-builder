# Infographic Generation — Implementation Spec

**Goal:** given study material (text or a URL's content), produce a
self-contained infographic as a single HTML file with inline SVG —
not a raster image. Live reference example built with this approach:
https://claude.ai/artifact/Jj4oq7uDwTmTtyk6TLLhAz

## Pipeline: two Claude calls, not one

1. **Extraction call** — study material in, structured JSON out.
2. **Design call** — that JSON in, one self-contained `.html` file out.

Keep these as two separate API calls. Asking for both content
summarization and visual layout in one prompt tends to produce
infographics that are either content-thin or visually cluttered.

---

## Stage 1 — Extraction call

**System/user prompt template:**

```
Extract the key teachable content from the material below into
structured JSON. Do not summarize in prose — output only JSON matching
this shape:

{
  "title": string,
  "lede": string,               // one sentence, <25 words
  "core_concept": { ... },      // 2-4 short key/value pairs, the "big idea"
  "items": [                    // 4-10 entries; nodes, steps, or comparison rows
    { "label": string, "detail": string, "meta"?: string }
  ],
  "comparisons": [              // optional — only if content has 2+ things
    { "name": string, "value": string }   // to compare on shared criteria
  ],
  "key_takeaway": string        // one sentence, what to remember
}

Only include fields that are actually supported by the source material.
Do not invent data, numbers, or examples that aren't present.

<material>
{study_guide_text}
</material>
```

Reuse this same JSON as the source for flashcard generation too —
keeps the infographic and the flashcards consistent with each other.

---

## Stage 2 — Design call

**System/user prompt template:**

```
Design an educational infographic as ONE self-contained HTML file
with inline SVG. No external images, no JS frameworks.

<content>
{stage_1_json}
</content>

Requirements:
- Pick ONE layout pattern that matches the content's actual shape:
  - sequence/process → horizontal or vertical chain/timeline
  - comparison → side-by-side cards or a data table
  - structure/parts → an "anatomy" diagram (labeled box breakdown)
  - hierarchy/categories → hub-and-spoke or nested groups
  Do not default to generic hero+cards if the content doesn't call for it.
- Encode meaning in color, not just decoration — e.g. if items have a
  binary or ordinal property (fast/slow, before/after, correct/incorrect),
  use two consistent accent colors for that property throughout.
- Define light AND dark theme CSS variables on :root (see Design
  System below) — do not hardcode a single background/text color.
- Fonts: import 1-2 Google Fonts via <link>, real fallback stacks.
  No Inter/Roboto/Arial as the display face — pick something with
  personality suited to the subject.
- SVG diagrams must use viewBox (not fixed px) so they scale.
- Keep captions short: <25 words per caption, <80 char line length
  in body text.
- No invented facts, numbers, or filler content beyond {stage_1_json}.

Before finalizing: check your own SVG/HTML for overlapping text,
clipped labels, or elements that overflow their container. Fix any
you find.
```

---

## Design system reference (what produced good results)

**Color** — 4-6 named hex tokens, defined as CSS variables, with a
light-mode and dark-mode value for each:
```css
:root{
  --bg:#F4F6FA; --panel:#FFFFFF; --panel-border:#D7DEE8;
  --text:#16202E; --text-muted:#5B6B80;
  --accent-a:#A66A00; --accent-a-bg:#FCEFD8;   /* e.g. "fast" / positive */
  --accent-b:#B23A26; --accent-b-bg:#FBE4DF;   /* e.g. "slow" / negative */
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0E1420; --panel:#171F2E; --panel-border:#2A3548;
    --text:#EDF1F7; --text-muted:#8B98AC;
    --accent-a:#F2B84B; --accent-a-bg:rgba(242,184,75,.14);
    --accent-b:#E86A5C; --accent-b-bg:rgba(232,106,92,.14);
  }
}
```
Avoid the generic AI-design tells: warm cream + terracotta, near-black
+ single neon accent, identical rounded cards with the same soft
shadow on everything, gradient washes as decoration.

**Type** — two families max: one distinctive display/heading face,
one clean body face. Add a monospace face *only* for genuinely
code-like or data-like tokens (field names, complexity notation,
addresses) — not as a generic "label" decoration.

**Layout patterns that worked:**
- *Chain/sequence diagram* — boxes in a row connected by SVG arrows
  (`<marker>` arrowheads), used for anything ordered or linked.
- *Comparison cards* — 2-3 panels, one property called out with a
  colored `.tag` badge.
- *Anatomy diagram* — a labeled box broken into fields, with pointer
  arrows to "ghost" (dashed) placeholder boxes for external references.
- *Data table* — for >4 rows of comparable structured data; badges
  inside cells instead of plain text for any binary/ordinal value.

**Reusable snippets:**

Badge (semantic color-coded value):
```css
.tag{
  display:inline-flex; align-items:center; gap:6px;
  font-family:"IBM Plex Mono", monospace; font-size:12.5px;
  font-weight:600; padding:3px 9px; border-radius:20px;
}
.tag.a{ color:var(--accent-a); background:var(--accent-a-bg); }
.tag.b{ color:var(--accent-b); background:var(--accent-b-bg); }
```

Arrow marker (for any connected-node diagram):
```html
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5"
    markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" fill="#8A97A8"></path>
  </marker>
</defs>
<line x1="150" y1="90" x2="220" y2="90" stroke="#8A97A8"
  stroke-width="1.6" marker-end="url(#arrow)"></line>
```

Node/box-with-field pattern (for anatomy or chain diagrams):
```html
<rect width="110" height="64" rx="8" fill="var(--panel)" stroke="var(--panel-border)"></rect>
<line x1="66" y1="0" x2="66" y2="64" stroke="var(--panel-border)"></line>
<text x="33" y="41" text-anchor="middle" font-size="24" font-weight="600" fill="var(--text)">1</text>
```

---

## Prompting checklist (include every design call)

- [ ] Stage 1 JSON is the only source of content — no new facts added
- [ ] One named layout pattern, chosen to fit the content's shape
- [ ] Color used to encode a real property, not just decoration
- [ ] Light + dark CSS variable tokens defined
- [ ] Fonts loaded via `<link>` with real fallback stacks
- [ ] SVGs use `viewBox`, not fixed pixel dimensions
- [ ] Self-check step for overlapping/clipped text before returning
- [ ] Output is one self-contained HTML file — no external JS/images
