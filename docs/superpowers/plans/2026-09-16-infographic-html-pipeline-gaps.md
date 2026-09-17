# Infographic HTML Pipeline — Gap Review & Additional Tasks

> **For agentic workers:** these are amendments to
> `docs/superpowers/plans/2026-09-16-infographic-html-pipeline.md`
> ("the base plan"), not a replacement. Do the base plan's Tasks 1-10
> first; the tasks below slot in at the point noted on each one. Same
> `superpowers:subagent-driven-development` workflow, same checkbox
> tracking.

**How this was produced:** read against the actual repo (`src/`,
`docs/`, `tools/`), not just the base plan's text — file/line
references below are real, checked against the code as it stands
today. The base plan's core call (sandboxed `srcDoc` iframe,
`allow-same-origin` with no `allow-scripts`, regex sanitizing as
defense-in-depth rather than the primary control) is sound and isn't
revisited here. What follows is what it doesn't cover.

---

### Task A: Generation feedback and cancellation

**Why this is missing, not just nice-to-have:** the base plan's "What
does not change" section lists `InfographicMode.tsx`'s phase machine
as untouched. That was true of the *shipped* feature, but this plan
changes what "generating" means underneath it: one call became two,
and the second one (`infographic-design`, 16000 max tokens — the
app's single largest ceiling) has to produce a full styled HTML
document, not a compact JSON object. The wait gets longer and now has
two distinct stages, and nothing about the loading screen changes to
reflect that.

Concretely, today (`src/components/InfographicMode.tsx:68-87`):
- `handleGenerate` calls `generateInfographic(deckId, deck!.name, chosenCards, detail, ai)` — **no `signal` argument**, even though `generateInfographic` already accepts one. There is no way to cancel a run, slow or not.
- The "generating" phase renders one static line — `"Writing the infographic…"` — for the entire run, extraction and design alike.

Compare `src/components/quiz/useDeckQuiz.ts:70,130-153,219,270` and
`QuizGenerating.tsx`, which already solved this for the other
long-running AI feature: an `abortRef`/`AbortController` pair, a
`stopGenerating` callback wired to a visible Stop button, and
progress text that names what's happening. That's the pattern to
mirror here, not invent fresh.

**Files:**
- Modify: `src/components/InfographicMode.tsx`
- Modify: `src/lib/infographicGenerator.ts` (small addition — see Step 2)

- [ ] **Step 1: Wire an AbortController through `handleGenerate`**

```tsx
const abortRef = useRef<AbortController | null>(null);

const handleGenerate = async (detail: InfographicDetail, chosenCards: Flashcard[]) => {
  setPhase("generating");
  const controller = new AbortController();
  abortRef.current = controller;
  try {
    const infographic = await generateInfographic(
      deckId, deck!.name, chosenCards, detail, ai, controller.signal
    );
    // ...unchanged...
  } catch (err) {
    if (controller.signal.aborted) { setPhase("setup"); return; }
    // ...unchanged error handling...
  } finally {
    abortRef.current = null;
  }
};

const stopGenerating = () => abortRef.current?.abort();
```

- [ ] **Step 2: Give the generator a way to report which stage it's in**

`generateInfographic` currently returns only the finished
`Infographic`. Add an optional `onStage` callback so the UI can show
something truer than one static line, without turning this into a
batch-progress system like quiz's (there's nothing to count — it's
two discrete calls, not N batches):

```ts
export async function generateInfographic(
  deckId: string, deckName: string, cards: Flashcard[],
  detail: InfographicDetail, settings: AiSettings,
  signal?: AbortSignal,
  onStage?: (stage: 'extracting' | 'designing') => void
): Promise<Infographic> {
  onStage?.('extracting');
  const extractReply = await callModel(/* ... */);
  // ...
  onStage?.('designing');
  const designReply = await callModel('infographic-design', [extracted], settings, signal);
  // ...
}
```

- [ ] **Step 3: Show the stage and a Stop button on the generating screen**

```tsx
if (phase === "generating") {
  return (
    <div className="infographic-generating">
      <span className="chalk-spinner" aria-hidden="true" />
      <p className="muted small">
        {stage === 'designing' ? "Designing the page…" : "Reading the cards…"}
      </p>
      <div className="form-actions">
        <button type="button" className="ghost-btn" onClick={stopGenerating}>Stop</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck, then a manual check** — start a Detailed
  generation, confirm the stage text changes partway through, and
  confirm Stop actually returns to Setup rather than hanging or
  surfacing an error banner.

---

### Task B: Parity tests for the hand-duplicated constants

The base plan's own "Global Constraints" names two pieces of data
that must be hand-kept in sync and says so explicitly:
`MAX_TOKENS` (`src/lib/aiTransport.ts` vs
`src/server/generateHandler.ts`) and the color-token block
(`src/index.css` vs `INFOGRAPHIC_DESIGN_PROMPT`). Both are correct
today — checked directly against `src/index.css`'s current `:root`
and `:root[data-theme="dark"]` blocks, byte-for-byte. But "correct
today, and a plan document says don't break it" is exactly the
situation regression tests exist for, and there currently isn't one:
`grep -rn "MAX_TOKENS" tools/` turns up nothing outside the two
source files. A future edit to either side — someone tuning a token
ceiling, someone reskinning the app's palette — has nothing to catch
the drift except a person remembering to re-read this plan.

**Files:**
- Modify: `tools/test-infographic.mjs` (append)

- [ ] **Step 1: Add a `MAX_TOKENS` parity check**

Both files already export their record as `MAX_TOKENS`, so the test
just imports both and compares the four `infographic-*` keys:

```js
import { MAX_TOKENS as CLIENT_TOKENS } from '../src/lib/aiTransport.ts';
import { MAX_TOKENS as SERVER_TOKENS } from '../src/server/generateHandler.ts';

console.log('\nMAX_TOKENS stays in step between client and server');
for (const key of ['infographic-extract-basic', 'infographic-extract-standard', 'infographic-extract-detailed', 'infographic-design']) {
  check(`${key} matches`, CLIENT_TOKENS[key], SERVER_TOKENS[key]);
}
```

(If either module doesn't already export its `MAX_TOKENS` record,
add `export` to the `const` — no other change needed; nothing
outside this test file should ever import it for a different reason.)

- [ ] **Step 2: Add a color-token parity check**

This one can't just diff two objects — one side is CSS, the other is
a prompt string. Cheapest real check: assert that every hex/rgba
value in `src/index.css`'s two token blocks appears verbatim
somewhere in `INFOGRAPHIC_DESIGN_PROMPT`.

```js
import fs from 'node:fs';
import { INFOGRAPHIC_DESIGN_PROMPT } from '../src/lib/infographicPrompt.ts';

console.log('\ndesign prompt color tokens match src/index.css');
const css = fs.readFileSync('src/index.css', 'utf8');
const root = css.slice(css.indexOf(':root {'), css.indexOf('\n}\n', css.indexOf(':root {')));
const dark = css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf('\n}\n', css.indexOf(':root[data-theme="dark"]')));
const values = [...(root + dark).matchAll(/#[0-9a-f]{3,8}\b|rgba\([^)]+\)/gi)].map((m) => m[0]);
for (const value of values) {
  check(`prompt contains ${value}`, INFOGRAPHIC_DESIGN_PROMPT.includes(value), true);
}
```

This is intentionally loose (string matching, not real CSS parsing —
`fs` and a slice is enough for a file this predictable), matching
this test file's existing style rather than reaching for a CSS
parser dependency for one check.

- [ ] **Step 3: Run the full suite, confirm both new sections pass,
  commit alongside whichever base-plan task last touched this file.**

---

### Task C: `InfographicSetup.tsx` describes the architecture being removed

The base plan lists `InfographicSetup.tsx` under "What does not
change." That's not quite right — it doesn't need *behavioral*
changes, but its copy does. `DETAIL_OPTIONS` (`src/components/infographic/InfographicSetup.tsx:15-19`):

```ts
{ id: "basic", name: "Basic", blurb: "The core ideas only — a couple of blocks, a few points each.", pageEstimate: "~1 page" },
```

"a couple of blocks" is naming the exact `InfographicBlock` concept
Task 1 deletes. Once this ships, there is no such thing as a block
anywhere in the system the user is looking at — the word will be
describing an internal data shape that used to exist, to a user who
never saw it as "blocks" in the first place (the shipped feature
already rendered blocks as plain visual cards with no block
terminology in the UI). It should read in terms of the new pipeline's
actual unit — items — e.g. *"The core ideas only — 4-5 key points."*

Separately, `pageEstimate` ("~1 page" / "~1-2 pages" / "~3 pages")
was presumably calibrated against the old block-rendering output.
Length is now a function of the extraction call's item count
(`ITEM_TARGET` in the base plan's Task 2: 4-5 / 6-8 / 8-10) *laid out
by a model making its own layout choice* — a hub-and-spoke of 8 items
and a data table of 8 rows are not the same length. This estimate
isn't necessarily wrong, but nothing in either plan checks it against
real output.

- [ ] **Step 1:** Rewrite the three `blurb` strings to describe items,
  not blocks.
- [ ] **Step 2:** After Task 10's end-to-end check produces real
  Basic/Standard/Detailed pages, eyeball each against its
  `pageEstimate` and adjust the wording (or drop the estimate) if it's
  now off.

---

### Task D: Strengthen the sanitizer, and two small prompt additions

**Sanitizer:** `sanitizeInfographicHtml` (base plan Task 3) is
correctly framed as defense-in-depth — the sandboxed iframe with no
`allow-scripts` is the real control, and that part of the design is
solid. But it's still a chain of regexes pattern-matching arbitrary
LLM-authored markup, which is a well-worn source of bypasses in
general (malformed/nested tags, unusual attribute ordering, vectors
the fixed pattern list doesn't anticipate — e.g. nothing here touches
`<meta http-equiv="refresh">` or `<base href>`, which don't need
script execution to misdirect a viewer). The fix is cheap here
specifically because `linkedom` is *already a dependency of this
exact repo* (`tools/test-html.mjs` uses it today) and is a pure-JS
DOM implementation — Node-safe, not a browser API — so it doesn't
trip the "nothing DOM/browser-only at runtime" constraint the base
plan places on `infographicPrompt.ts`. Parsing the reply into a real
DOM and removing dangerous nodes/attributes structurally is strictly
more robust than string patterns, for similar effort:

```ts
import { parseHTML } from 'linkedom';

export function sanitizeInfographicHtml(html: string): string {
  const { document } = parseHTML(html);
  document.querySelectorAll('script, iframe, object, embed, meta[http-equiv="refresh"], base')
    .forEach((el) => el.remove());
  document.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const isEventHandler = attr.name.toLowerCase().startsWith('on');
      const isDangerousUri = /^\s*(javascript|data):/i.test(attr.value) &&
        ['href', 'src', 'xlink:href'].includes(attr.name.toLowerCase());
      if (isEventHandler || isDangerousUri) el.removeAttribute(attr.name);
    }
  });
  return document.toString();
}
```

Worth weighing against the base plan's existing regex version:
`linkedom` adds real weight to the Netlify function's bundle (it's
imported into the server bundle the same way the rest of
`infographicPrompt.ts` is) — reasonable to check the cold-start
impact isn't worse than the security upside is worth before locking
this in. If the team decides the regex version is an acceptable
trade for a smaller bundle, that's a legitimate call — but it should
be a decision made with the trade-off stated, not a default.

**Two design-prompt additions** (`INFOGRAPHIC_DESIGN_PROMPT`, base
plan Task 3) — small, in the same section that already tells the
model which fonts/colors/layout to use:
- A screen-reader line: each `<svg>` diagram should carry a `<title>`
  naming what it shows, the same way the base plan already asks for
  real semantic HTML elsewhere in this codebase's own UI.
- A `lang` line: `<html lang="...">` should match the actual language
  of the extracted content, not default to `en` — worth checking
  whether the rest of the pipeline (`cardPrompt.ts`, `quizPrompt.ts`)
  makes any assumption about deck language before deciding whether
  this is a real gap or an existing, consistent, English-only
  assumption across the whole app. (Checked briefly here: neither
  prompt currently addresses spoken-language at all, so this may be
  out of scope for this plan specifically rather than a regression it
  introduces — flagging for a decision, not asserting it's broken.)

- [ ] **Step 1:** Swap the regex sanitizer for the `linkedom` version
  above (or record the explicit trade-off decision to keep regex).
- [ ] **Step 2:** Add the SVG-title and `lang` lines to
  `INFOGRAPHIC_DESIGN_PROMPT`.
- [ ] **Step 3:** Re-run `tools/test-infographic.mjs`'s design-block
  tests (base plan Task 3, Step 1) — the dirty-HTML fixtures there
  should still get fully cleaned by the new sanitizer; add one fixture
  covering `<meta http-equiv="refresh">` since that's new coverage.

---

### Task E: Hosted-mode latency vs. the platform's function timeout

This is a real production risk that neither plan nor the app's
existing docs (`docs/tuning-notes.md`'s "Model response ceilings")
currently account for, and it's specific to hosted mode (BYOK calls
Anthropic directly from the browser and never touches this limit).

- The client's own timeout, `REQUEST_TIMEOUT_MS` in
  `src/lib/aiTransport.ts:94`, is 120 seconds.
- `handleGenerate` (`src/server/generateHandler.ts:167-186`) sets no
  timeout of its own — it `await fetch(...)`s Anthropic directly, so
  the entire Netlify function's execution time is bounded only by
  the platform, not by any app code.
- Netlify's current documented default for synchronous functions is
  a 60-second execution limit (docs.netlify.com/functions/build/,
  checked today) — half the client's own timeout.

`infographic-design` is this app's single largest `MAX_TOKENS`
ceiling (16000, tied with `cards`/`vignette`/`ocr`), and unlike those,
it has to spend that budget on a full styled document — font
`<link>`s, a CSS token block, inline SVG markup — rather than compact
JSON, which is the kind of output that plausibly runs long enough to
matter. And this plan turns what used to be one call into two,
doubling the number of chances to hit this ceiling in a single
"generating" run. If the design call alone ever exceeds ~60 seconds
in the hosted deployment, Netlify kills the function before the
client's 120-second timeout ever fires, and the failure shows up to
the user as a generic network/502 error with no `stopReason` to
distinguish it from any other failure — exactly the "every failure
mode looks identical" problem `InfographicMode.tsx`'s own comment
(line ~81) already says it's trying to avoid.

- [ ] **Step 1:** After Task 10's end-to-end check, specifically time
  the hosted-mode `infographic-design` call (Detailed, a full deck) a
  few times and note the real p95.
- [ ] **Step 2:** If it's anywhere near 60s, either raise the
  function's own timeout in `netlify.toml` (`[functions."generate"]`
  `timeout` — Netlify supports up to 26s on most plans, higher on
  Enterprise; confirm the actual ceiling available on this
  deployment's plan before relying on it) or lower
  `infographic-design`'s `MAX_TOKENS` to a value comfortably clear of
  the measured latency, accepting shorter pages as the trade-off.
  Either is a legitimate call; shipping with neither checked is the
  gap.

---

### Task F: Smaller notes, fold into Task 10's manual checklist

- **Partial-failure cost:** `generateInfographic` throws the whole
  run away if the design call fails after extraction already
  succeeded (and was paid for) — a retry redoes both. Not necessarily
  wrong (matches how the rest of this generator is written — no
  partial-save concept anywhere in it), but worth a deliberate
  "yes, that's fine for v1" rather than an oversight. If it's not
  fine, the fix is small: catch the design-call failure specifically
  and let the Setup screen retry just that step with the
  already-extracted JSON.
- **Font loading inside the sandboxed frame:** add one line to base
  plan Task 10 Step 3's manual check — open the iframe's content in
  dev tools and confirm the Google Fonts request actually succeeds.
  A blocked or slow font load fails silently (the page still renders,
  just in a fallback font), so nothing else in either plan would
  catch it.
- **Abort path:** once Task A lands, Task 10's manual check should
  also cover pressing Stop mid-generation and confirming it returns
  to Setup cleanly rather than surfacing an error banner (the
  `catch` block needs to special-case an aborted signal rather than
  treat it as a generation failure — see Task A Step 1).
