# Tuning notes

Why the numeric constants in `src/lib/` are the values they are.

Each one was measured against real decks rather than guessed, and the measurements are
long enough that keeping them beside the code buried the code. They live here instead;
the constants carry a two-line summary and a pointer to the section below.

Anyone changing one of these numbers should read its section first — most of them were
already tried at another value, and the section says what broke.

---

## Card de-duplication

`src/lib/cardValidation.ts` — `DUPLICATE_FRONT`, `DUPLICATE_BACK`, `MIN_WORDS_TO_COMPARE`

### Why both halves must match — 0.9 / 0.9

A deck legitimately asks several questions about one idea. "What is the therapeutic
range" and "what raises the level" share most of their words and are different cards, so
a similar front alone is not duplication. It is only duplication when the same question
has the same answer.

The thresholds are very high, and every step down from here was measured against the
golden pages. At **0.75 / 0.6** the pass dropped seven cards from a single page:

- "Ternary Expression Conditional Statement" was dropped as a duplicate of "If-Else
  Conditional Statement".
- Three distinct for-loop variants were dropped whose answers are program output.
  `1 2 3 4 5` and `1 2 3 2 4 6 3 6 9` share four digits in five and score **0.8**.

Only near-verbatim restatement survives 0.9, which is the only thing word overlap can
honestly identify.

**The two mistakes do not cost the same.** A duplicate that survives is a card seen
twice. A distinct card wrongly dropped is material the student never studies and cannot
tell is missing.

### What this deliberately does not catch

Comparing words only finds duplicates that share vocabulary. Two cards making the same
point in different words survive:

```
"What general rule applies when keeping two state variables synchronized?"
  -> "Try lifting state up instead of synchronizing two separate variables."

"What should you consider when synchronizing state across components?"
  -> "Consider lifting state up."
```

Those score **0.5** on their fronts — below any threshold that still keeps genuinely
different cards, because a pair like "how do you fix a race condition" / "what else
matters when fetching" scores **0.8** on fronts alone and must survive. Requiring both
halves is what makes the second pair safe, and it is also what lets the first pair
through.

Catching restatement needs meaning, not spelling. The second chance is at selection
time in `quizSelection.ts`, where the model has reworded both cards into questions and
the wording is more uniform than the cards were.

### Why four words minimum — `MIN_WORDS_TO_COMPARE = 4`

The measure divides by the shorter text, which is what makes a terse card comparable to
a wordy one, and also what makes a very short one match everything.

"What is function?" carries a single content word, so it scored **1.00** against every
other card on the page and took six of nine cards with it — including "Built-in
functions — what does this C++ program print?", whose answer was "Square Root: 5". One
word in common is not evidence of anything.

Below four words on either the fronts or the backs, no judgement is made and the card is
kept. Exact repeats are still caught by the normalized key.

---

## Question de-duplication

`src/lib/quizSelection.ts` — `SAME_STEM`, `SAME_ANSWER`, `MIN_ANSWER_WORDS`

### Why the weight is on the answer — 0.5 stem / 0.8 answer

This is the opposite of the card thresholds, and deliberate. By selection time the model
has reworded both cards, so two questions written from a duplicated fact often share
little stem vocabulary — but they still have to arrive at the same answer, because the
underlying fact is the same.

A matching answer with a related stem is the signal. A matching stem with different
answers is two good questions about one topic:

```
"What is the therapeutic range for lithium?"   |  share 4 stem words in 5
"At what level is it toxic?"                   |  answers share almost nothing
```

Both must be asked, and the answer weighting is what keeps them.

### Why two answer words minimum — `MIN_ANSWER_WORDS = 2`

The same trap the card thresholds guard against, and sharper here: the prompt caps every
option at fifteen words and the good ones are far shorter. A one-word answer is a subset
of any answer containing that word, so it scores 1.00 against them all.

Measured:

```
"Which phase compares element trees?"      -> "Reconciliation"
"Which phase commits changes to the DOM?"  -> "Reconciliation phase"
```

Those score **0.50** on their stems and **1.00** on their answers, and one of two
genuinely different questions was dropped from the test.

Two is the lowest bar that closes that hole, not a tuned figure. "Lifting state up"
carries exactly two content words and is a real duplicate that must still be caught;
raising the bar further would start discarding the detections this exists for.

The asymmetry is the same as it is for cards: a duplicate that survives asks something
twice, a distinct question wrongly dropped is a shorter test missing material.

---

## The overlap measure

`src/lib/textUtils.ts` — `wordOverlap`, `overlapRatio`

### Overlap coefficient, not Jaccard

Dividing by the union punishes a short text for being short. These two are the same
question asked twice, but one is half the length of the other:

```
"How do you reset the state of an entire component tree?"
"What React technique lets you automatically reset a component's state when a
 prop like userId changes?"
```

Jaccard scores them below any threshold that still excludes unrelated cards. Dividing by
the *shorter* set asks the question that actually matters: is the smaller text saying a
subset of what the larger one says?

The cost is that a very short text is all the more likely to be wholly contained in
something else — hence the minimum-size guards documented above.

### Why it takes word sets rather than strings

De-duplication compares every card against every card it has kept, so tokenizing inside
the comparison re-derives one card's words once per *pair* rather than once per card,
and the pairs are quadratic.

The cost lands hardest on the decks that need de-duplication least: a deck of genuinely
distinct cards drops nothing, so every card is compared against every earlier one and
none of the cheap guards fire.

Measured on 250 such cards: **3.1 seconds** tokenizing inside the comparison, **36 ms**
comparing pre-extracted sets. 500 cards took eight seconds. This runs on the main
thread immediately after drafting, while someone waits to see their cards.

---

## Model response ceilings

`src/lib/aiTransport.ts` — `MAX_TOKENS`. The server has its own copy in
`src/server/generateHandler.ts`; they must stay in step.

| Task | Ceiling |
|---|---|
| `cards` | 16000 |
| `quiz` | 8000 |
| `vignette` | 16000 |
| `vignette-audit` | 1000 |
| `ocr` | 16000 |
| `infographic-extract-basic` | 2000 |
| `infographic-extract-standard` | 3000 |
| `infographic-extract-detailed` | 4000 |
| `infographic-design` | 24000 |

**Quiz — why not 4000.** A quiz question costs about five strings where a card costs
two, so a quiz batch sits far closer to the ceiling. At 4000 a full batch came back
truncated mid-JSON and the salvage pass quietly lost the tail. That was the cause of
test generation only ever covering part of a deck.

**Cards — why not 4000.** Cards were left at 4000 on the assumption that two strings a
card could not reach it. A dense reference page defeats that: the prompt asks for one
card per table cell and one per defined term, so a single lecture slide of four bulleted
quadrants is worth twenty cards, and a batch of such pages asks for fifty or more. A
16-page clinical deck hit the ceiling on three batches out of four and silently fell
back to rule-based cards for three quarters of the document.

**Vignette — why 16000.** A board-style item is the most expensive thing here: a
four-sentence scenario, five homogeneous options and an explanation, against the ~420
tokens a recall question costs.

**Why the headroom is close to free.** The ceiling is a limit, not a reservation. An
ordinary batch still generates and bills only a couple of thousand tokens.

**Infographic — why 2000/3000/4000 for the extraction stage, and a flat 16000 for design.** The extraction reply is a small JSON object — a title, a lede, a handful of short items — so these ceilings are generous relative to what a real reply costs; they scale with the per-level item target (`ITEM_TARGET` in `infographicPrompt.ts`) the same way the three levels' targets do. The design reply is a full self-contained HTML document with inline CSS and inline SVG, and it stays flat across all three detail levels rather than scaling with them: layout markup and CSS boilerplate dominate the length far more than item count does, so a Basic-detail page and a Detailed-detail page cost roughly the same to generate.

**Request timeouts have to cover the ceiling they sit above.** A real generation failed with "The drafting request timed out after 120 seconds" — not because anything was stuck, but because the two constants disagreed. Measured 2026-09-16 against a 24-card deck, `infographic-design` returns 7,600–11,100 output tokens at a steady ~120 tokens/second, so its 16,000-token ceiling implies roughly 133 seconds of generation, which the single global 120-second timeout forbade. Observed wall-clock for that one call ranged from 42s to 95s across runs, which is why this failed intermittently rather than always. `infographic-design` now has a 360-second budget of its own (`TIMEOUT_OVERRIDES_MS` in `aiTransport.ts`), sized to cover its full ceiling at a conservative ~70 tok/s. The other 16,000-token tasks keep the 120-second default deliberately: they batch, so their real output lands far below the ceiling and the same arithmetic doesn't apply. `tools/test-infographic.mjs` pins the relationship so the ceiling can't be raised again without the timeout following it.

**Raised to 24000 after a dense deck was truncated.** An 84-card Apollo Client deck at Detailed extracted 12 items and 3 comparisons, and rendering that much content as styled HTML with inline SVG ran the design reply into the old 16000 ceiling: `stop_reason: max_tokens`, a document cut off mid-markup, and a page that could not be used. Freed from the ceiling the same content finishes naturally at ~12,500 tokens, so 24000 is real headroom rather than a new target. The timeout moved with it — 24000 at the conservative ~70 tok/s floor implies ~343 seconds, so the budget is now 360. Measured cost: that deck takes ~110 seconds for the design call, on top of ~20 for extraction.

**The wait is the known weakness of this arrangement.** ~130 seconds behind an unchanging spinner is poor, and every increase to the ceiling makes it worse, because tokens and seconds are the same axis. The durable fix is to stream the design call so the timeout can be stall-based rather than wall-clock, and so the screen can show progress; that changes the transport contract shared by every AI feature here, so it was deliberately deferred rather than bolted on.

**Hosted mode and this 360-second budget.** That number is the *browser's* patience and applies to bring-your-own-key and local `npm run dev` runs. A deployed hosted request also passes through the serverless platform's own execution limit, which is far shorter than the ~110 seconds measured here, and no client-side timeout can extend it. The design call as it stands is therefore unlikely to survive a deployed synchronous Netlify function; making hosted mode work needs either streaming, a background function, or a materially lower `infographic-design` ceiling. Unverified against a real deployment — flagged here rather than guessed at.

**Known accepted regression — infographic markup semantics.** The block renderers this feature used to ship guaranteed accessible markup: real `<table>` with `<caption>` and `<th scope="col">`, `<ol>` for ordered content, ARIA labels on stat callouts. Under the HTML pipeline the model authors its own markup and only a prompt clause (`SEMANTICS` in `INFOGRAPHIC_DESIGN_PROMPT`) asks for those. This is a real, accepted downgrade that came with rendering model-authored documents; it is not a bug to be rediscovered. The iframe itself carries a `title`, and its content does reach the accessibility tree.

**Vignette-audit — why 1000.** The audit call returns one verdict object per question in
the batch — an id and a boolean — never prose, so it costs a small fraction of what
generating the batch did. This was a starting estimate, not a measured one, when it
shipped; `stopReason` is now logged for this call (see the 2026-09-05 entry below), so a
future real run can say whether 1000 was ever hit — this pass didn't observe that either
way.

**OCR — why 16000.** A transcribed scanned page can be as text-dense as a card-drafting
batch — the same reasoning as `cards`' ceiling — so it starts at the same value rather
than a fresh estimate. This was not measured against a real run when it shipped; see the
2026-09-07 entry below for whether `docs/pdf-test/EXAM 1 STUDY GUIDE.pdf`'s 16 pages ever
approached it.

---

## Batch sizes

`src/lib/quizGenerator.ts` — `BATCH_SIZE`, `RETRY_BATCH_SIZE`, `VIGNETTE_BATCH_SIZE`,
`VIGNETTE_RETRY_BATCH_SIZE`

The binding constraint is the response ceiling above, not the request size.

**Recall, 8 per batch.** Measured on real cards, a question costs about 420 output
tokens when options run to full sentences, so ten needed ~4200 against the old ceiling of
4000 — batches came back stopped at exactly `max_tokens`, truncated mid-JSON, and the
salvage pass kept only the objects that had closed. With the ceiling at 8000 and options
capped at 15 words (~330 tokens a question), eight cards costs ~2600: a wide margin
rather than a cliff.

Eight also keeps a 100-card deck to 13 requests, comfortably under the 20/min rate
limit. Five would need 20 requests and sit right on it.

**Vignette, 4 per batch.** A vignette costs about twice a recall question. Halving the
batch keeps a request the same distance from the ceiling as the recall path sits at,
which is the margin that stops replies coming back truncated.

**Retry passes are halved again** (4 and 2). Whatever cost the first pass its stragglers,
a smaller batch is the one lever that helps for every cause of it.

---

## Neighbour and context payloads

`src/lib/quizGenerator.ts` — `NEIGHBOUR_LIMIT`, `NEIGHBOUR_CHARS`, `CONTEXT_LIMIT`,
`CONTEXT_CHARS`

Both paths send other cards from the deck alongside the batch, for different reasons.

**Recall — neighbours as candidate distractors.** Sending the answers alone left the
model unable to do the check the prompt calls most important: whether a neighbour's
answer is *also* correct for the stem being written. A deck that states the same fact
twice — a recap card beside the card it recaps — offers an answer that reads as a
perfect near miss and is simply right, and nothing in a bare list of answers reveals
that. Sending the question each answer belongs to is what makes the check possible.

**Vignette — context as source material.** A vignette has to describe how something
presents, and the only honest source for that is other cards from the same lecture.
Front and back travel together for that reason: it is the difference between a model
drawing on the lecture and a model drawing on itself.

**Why context gets fewer cards with more room each** (12 × 200 chars vs 20 × 160): a
neighbour only has to be recognisable as an option, where a context card is being read
for the detail in it.

---

## 2026-09-05 — prompt-text hardening and the vignette audit pass

Three real gaps, found by reading the prompts against their own stated rules rather
than against general prompt-writing advice, and one new mechanism. All prompt text is
in `src/lib/cardPrompt.ts` and `src/lib/quizPrompt.ts`; not yet run against real
output — that is the open item at the end of this entry, not something already
confirmed.

**Cards — rule 1 (ATOMIC) contradicted rule 5.** Rule 1 said "split compound
statements," unconditionally, while rule 5 allowed a list-shaped back — and the quiz
prompt already had a dedicated rule for "when a card's back is... a long list," which
only makes sense if list-backed cards are expected to exist. Rule 1 now carves out a
small, bounded set of parallel items (two to six) that only mean anything together.
That bound is a default, not a measured one — worth checking against a source with an
8+ item list, where it should still force a split.

**Cards — rule 3 (REAL QUESTIONS) didn't rule out a front leaking its own answer.**
Naturalness and non-leakage are different failures; a grammatically natural question
can still hand back the fact it's testing. Added a second "prefer X over Y" pair in the
prompt's own established style.

**Cards — new rule 7, no cross-section repeats.** A batch sends up to four sections at
once, and this file's own "Card de-duplication" section above states the reworded-
duplicate safety net exists only for quiz questions at selection time, not for cards.
A recap section restating an earlier definition could produce two differently-worded
cards for one fact, invisible to the 0.9/0.9 word-overlap check. Scoped to "the same
fact," not "the same topic," to avoid merging genuinely distinct content that merely
shares vocabulary — not yet tested against a document with that exact pattern.

**Quiz + vignette — the neighbour/context double-correctness check compared questions,
not answers.** The existing check ("if that question is asking the same thing... its
answer is ALSO CORRECT") is a proxy that misses a synonym pair reached by differently-
worded questions — "tachycardia" as a distractor is unsafe against a correct answer of
"increased heart rate" regardless of how different the two fronts read. Added directly
to a new shared `distractorSafetyRules()` in `quizPrompt.ts`, used by both prompts, so
an edit to this rule can't land in one and be missed in the other.

**Vignette — invented distractors weren't held to the scenario's own grounding
standard.** The GROUNDING RULE stops fabricated vitals/labs/history; nothing stopped an
invented wrong diagnosis from being a real, board-relevant differential for the same
presentation (e.g. "unstable angina" against an MI vignette) — which this file's own
header comment calls out as the worst failure a board-exam tool can produce. Folded
into the same shared `distractorSafetyRules()` call, worded for the clinical domain.

**Vignette — no equivalent of the recall prompt's double-correctness check at all.**
Recall has one; vignette, sourcing distractors the same way from context/neighbour
cards, had nothing. Added as its own paragraph, since it also needed a vignette-only
remedy (recall can't "sharpen a stem" the way a vignette can be given another
distinguishing finding).

**Vignette — added a NO TEST-TAKING SHORTCUTS rule (negative lead-ins only).** Real
PANCE-style banks use "all of the following EXCEPT" — a risk the plain recall prompt
doesn't share, since recall's LEAD-IN section pulls toward real board conventions and
recall's doesn't. The "all/none of the above" half of this is *not* prose here — see
below, it's a deterministic code check on both styles instead, since it's a fixed
idiom and prose can be skipped where a string match can't.

**`toQuestion()` — "all/none of the above" is now rejected in code, not just asked for
in the prompt.** A banned *correct* answer voids the question (no single fact being
tested); a banned *distractor* is filtered like a duplicate, which can still leave
enough good ones to keep the question. Deliberately **not** done for negative-stem
phrasing — a naive string check (e.g. flagging "not") would wrongly reject a real card
about, say, a NOT gate. That guard stays prose-only for this reason.

**New: the `vignette-audit` task.** Vignette generation is the one place this app asks
a model to invent framing around real facts in the same breath it judges the framing
acceptable — and there was no backstop for that judgment being wrong, unlike the
distractor-count rule, which `toQuestion()` already enforces regardless of what the
prompt says. Added a second, small call (`VIGNETTE_AUDIT_SYSTEM_PROMPT` in
`quizPrompt.ts`, wired into `generateQuestionsForCards`'s `runBatch` in
`quizGenerator.ts`) that reviews an already-written vignette batch for the same two
things — invented findings, and a distractor that's plausibly also correct for the
vignette as written — and drops anything it flags. A flagged card is not lost; it's
retried next pass, same as a malformed reply always has been.

Considered and rejected before landing on this: migrating to Anthropic tool-use for
schema-enforced option counts. The count problem it would fix is already handled by
`toQuestion()`'s slice/reject logic; the problem tool-use *can't* fix — truncation —
would still need the exact same salvage-parsing this file already relies on. Three
files of changes for an already-mitigated, unevidenced problem didn't clear this
project's own bar.

Also considered: running the audit on a cheaper model tier, and batching several
generation batches into one audit call to cut request count. Rejected the first —
spotting a clinically-plausible-but-wrong differential is a real reasoning task, not a
cheap classification one. Rejected the second on the numbers: a vignette generation
call runs against a 16000-token ceiling and, per "Model response ceilings" above,
typically still takes many seconds to generate a couple of thousand tokens — that
latency, not request count, is already what keeps a run under the hosted 20/min limit,
so one small audit call per batch doesn't need the extra complexity.

**Resolved 2026-09-05:** run for real as part of the prompt-quality-refinements plan.
Parsing, selection, and compilation checks (Task 4 of that plan) passed — `tsc -b` is
clean, and `tools/test-coverage.mjs` made real generation calls against the golden
decks (`tools/fixtures/golden/*.json`, via `tools/fixtures/pages/*.html`), landing at
94/94 cards getting a question across six decks with 0 batches truncated.
`tools/test-quiz.mjs`, `tools/test-vignette.mjs`, and `tools/test-neighbour-context.mjs`
each made their own real generation pass against their own fixtures
(`tools/fixtures/quiz-cards.json`, `tools/fixtures/pance-cards.json`, and
`tools/fixtures/react-effects-cards.json` respectively), all passing. The payload test
tool could not be run — it requires a `PDF`
fixture this repo deliberately doesn't check in — but that gap doesn't weigh against
confidence here, since the only change to that file's path was the
`CARD_SYSTEM_PROMPT` string, not any parsing function. The audit pass's reject rate
over the vignette fixture run (Task 6) was high on first pass: 8 of the first 16
questions generated (2 of 4 first-pass batches, entirely) were flagged and dropped for
retry, landing at 16/16 once the smaller retry batches ran clean. Per the calibration
note above, that is a rate worth recording plainly rather than waving past — though
this pass does not attempt to tune the audit prompt itself, only to make the rate
visible for the first time. Temperature was still not touched in this pass; that
remains open below.

---

## 2026-09-05 — splitting-rule rewrite and distractor plausibility

**Cards — rule 1 (ATOMIC) restructured as an ordered test.** The prior wording packed
two conditionals into one sentence ("split X, unless Y — but split anyway if Z"),
which is a shape models apply inconsistently: reports of both over-splitting (a plain
descriptive clause treated as a "distinct detail") and under-splitting (a number
embedded in a shared sentence not triggering a split) were coming from the same rule.
Rewritten as three ordered branches with a worked example pair, and a new explicit
bound: a parallel set of more than six items with no per-item detail must now be split
into smaller groupings rather than staying on one long list-back card — closing the
exact gap the previous entry flagged as untested ("worth checking against an 8+ item
list, where it should still force a split"). Verified with a new synthetic-fixture
tool, `tools/test-card-splitting.mjs`, rather than a real document — see that file's
own comment for why a directed fixture was chosen over an incidental one. Run against
three synthetic sections: a sentence naming two attachment styles each with its own
prevalence percentage split into 2 cards, one per percentage — the intended outcome
for the "carries its own distinct detail" branch. A sentence naming all four
attachment styles with no per-item detail stayed on 1 card naming all four — the
intended outcome for the "small bounded set" branch. A 9-item list of insomnia causes
with no per-item detail split into 3 cards, grouped by natural category (lifestyle
factors, psychological factors, medical conditions) rather than one 9-item card or
nine single-item ones — the rule only requires "smaller groupings," not semantic
coherence, so the model grouping meaningfully on its own is a stronger result than the
rule strictly asked for. All three of the tool's own structural assertions passed.

**Quiz — rules 4 and 6 no longer pull against each other for invented distractors.**
Rule 4's "unambiguously wrong" framing (already the strongest rule in the file) gave
no guidance on invented distractors beyond "clearly and defensibly wrong," which a
model can satisfy with a safely irrelevant fact — plausible-sounding to no one, and
arguably the source of "not close enough" reports. Rule 6 now carries a concrete
technique (mutate the correct answer along one axis: adjacent value, sibling term,
adjacent step, same-family mechanism) with a worked good/bad pair, and rule 4 now
points forward to it instead of duplicating "write your own" guidance in two places. A
real recall-quiz run read as same-family confusions throughout: a while-loop timing
question's distractors were other loop-timing misconceptions, a for-loop syntax
question's distractors were other syntactically-plausible loop variants, a
switch-case question's distractors were other kinds of values one might mistakenly
think are valid case labels. No "obviously unrelated true fact" distractor — the
exact failure mode rule 6 now targets — was observed in this run.

**Quiz — the model was never told the neighbours list is ordered.**
`quizGenerator.ts`'s `nearestFirst` (topic, then source page, then the rest) has
ranked neighbours since before this entry, but `QUIZ_SYSTEM_PROMPT` never said so —
the model had no reason to prefer an early entry over a later one. Added one sentence
to point 1 of "Using the neighbouring cards."

**Quiz — the vignette audit's reject rate is now visible.** `auditVignettes` in
`quizGenerator.ts` dropped flagged questions silently; it now logs how many of a batch
were flagged, which is what the previous entry's open item asked someone to go
measure. Running the real vignette generator against `tools/fixtures/pance-cards.json`
(16 cards), first-pass generation split into 4 batches of 4 questions; the audit
flagged 2 of those 4 batches entirely (8 of the first 16 questions written), logging
"Vignette audit flagged 4 of 4 question(s); dropped for retry." twice. All 8 succeeded
on the smaller-batch retry (2 cards per batch) with nothing flagged, landing the run
at 16/16 cards answered, 8/8 batches total, 0 truncated. A 50% first-pass batch reject
rate is high enough to record plainly rather than wave past — per the calibration note
above, a high rate points at the audit prompt itself being too strict — but this plan
does not attempt to tune that prompt; it only makes the rate visible for the first
time. That said, the logging added in this pass didn't yet capture `stopReason` for
the audit call, so this run cannot say whether any of the flagged batches were actually
a truncated or malformed audit reply rather than a genuine "unsafe" verdict on every
question — the "Model response ceilings" section's open question about whether the
audit call ever needs more than 1000 tokens is still unanswered by this run. The
audit's logging now reports `stopReason` and a separate count of ids the reply never
covered, so the next real run is what would actually answer it. Separately,
`tools/test-neighbour-context.mjs` — which measures
double-correctness (a neighbour's answer also being correct for a
differently-worded stem), not distractor plausibility — showed no regression from
this plan's changes: a real before/after comparison (before: the pre-change commit in
a temporary worktree; after: this plan's changes) flagged 3 of 24 questions both
times, same rate with different specific pairs. Expected, since rules 4/6 target
distractor plausibility, not the double-correctness check, which is governed by
separate, untouched prompt text (`distractorSafetyRules()` and point 2 of "Using the
neighbouring cards").

**Still open:** temperature has still never been set on any of these calls; if it is
tried, score it by the vignette audit's flag count (now logged) rather than by eye
alone.

---

## 2026-09-07 — PDF OCR support

**Why this exists.** `docs/pdf-test/EXAM 1 STUDY GUIDE.pdf` — 16 pages, ~107MB, every
page a full-page scan with zero embedded text — could not produce a single flashcard
before this: `pdfParser.ts` either dropped a zero-text page silently (a mixed PDF) or
failed the whole upload (a fully-scanned one). Scanned pages are now rendered to JPEGs
and transcribed through Claude's vision (a new `ocr` AI task, reusing the existing
hosted/BYOK transport), merged back into the normal `DocumentSection` pipeline, and
drafted into cards exactly like any other page. See
`docs/superpowers/specs/2026-09-07-pdf-ocr-support-design.md` for the full design.

**Verification.** `tsc -b` and `npm run build` both passed. `tools/test-ocr.mjs`'s three
parts (response parsing, multimodal transport, full batch/retry round trip) all passed
for real — an `ANTHROPIC_API_KEY` was available, so none were skipped. The end-to-end
manual pass against the real test PDF (Task 7, Step 9) produced real drafted cards in
the correct page order, but only on the second attempt. The first attempt reached the
review screen with the "reading scanned pages" OCR banner and finished drafting, but 2
of the 16 pages failed OCR with real `413 Invalid or oversized "images"` errors from the
server — "Found 16 pages and drafted 283 candidate cards," with an AI notice reading "2
of 16 scanned pages could not be read." Root cause: this PDF's declared page MediaBox is
set to the source photo's raw pixel dimensions rather than a real physical page size
(one page declared 2232×3506 "points"), so the fixed `PDF_RENDER_SCALE = 1.5` multiplier
produced 12–17.6 megapixel canvas renders, well past the `MAX_IMAGE_BASE64_CHARS`
guardrail. Fixed in commit `b58aa50` (reviewed clean) by adding
`MAX_RENDER_DIMENSION = 1600` (pixels) to `src/lib/pdfParser.ts` and changing
`renderPageToJpeg` to compute
`scale = Math.min(PDF_RENDER_SCALE, MAX_RENDER_DIMENSION / longerEdgeInPoints)` instead
of always using `PDF_RENDER_SCALE` directly — bounding the render to at most 1600px on
the longer edge for any PDF with an abnormally large declared page size, while leaving
normal-sized PDFs (Letter, A4, etc.) unaffected (a 792pt Letter page: `1600/792 ≈ 2.02`,
so `min(1.5, 2.02) = 1.5`, unchanged). On the second attempt, all 16 pages transcribed
successfully — "Found 16 pages and drafted 310 candidate cards," zero failed pages, zero
AI notice, zero browser console errors, cards appearing in correct page order (Page 1's
cards before Page 2's, and so on). The mixed-PDF manual pass (Task 8, Step 2) was
skipped — no mixed-PDF fixture (some real-text pages plus some scanned pages in one
file) was available in this worktree.

**Open, not yet done:** the `ocr` ceiling (16000, borrowed from `cards`) still hasn't
been measured against a real overrun — `stopReason` never came back `max_tokens` for the
`ocr` task in this run, whether in `tools/test-ocr.mjs`'s real pass or the end-to-end
manual pass, so that number is still unmeasured against real overrun, exactly as
anticipated when it shipped; if a future run does hit it, that's the signal to raise it,
the same way `cards`' own ceiling was raised after a real overrun (see "Cards — why not
4000" above). `PDF_RENDER_SCALE` (1.5), `PDF_RENDER_JPEG_QUALITY` (0.82), and the new
`MAX_RENDER_DIMENSION` (1600) are no longer purely-untested guesses: they were exercised
against a real, unusually large-format scanned document and found to need the dimension
cap, which is now in place and confirmed working end to end. The one thing this run did
not confirm is the mixed-PDF path — real-text pages and scanned pages together in one
file — since no fixture was available; that manual pass was skipped rather than asserted
as passing.

## 2026-09-19 — application questions

A third question style, "Apply it" (`APPLICATION_SYSTEM_PROMPT` in
`src/lib/quizPrompt.ts`). Everything below is a **starting estimate**, chosen by analogy
with the two existing styles; none of it has been measured against real batches yet.
Replace each estimate with a measurement the first time `tools/test-application.mjs`
is run with a key.

**Batch size 6, retry 3.** An application question is a one-to-three-sentence scenario
or a short program plus four options — between a recall question (~330 output tokens)
and a vignette (roughly double) in size. Six sits between the recall path's 8 and the
vignette path's 4. To measure: output tokens per question on the golden decks and on
`tools/fixtures/quiz-cards.json`, and whether any batch comes back truncated.

**Ceilings: `application` 16000, `application-audit` 1000.** The generation ceiling
matches `vignette`; the ceiling is headroom, not a reservation, so over-estimating it
costs nothing. The audit reply is a verdict list, the same shape as `vignette-audit`.

**Rate limit.** Each batch makes two sequential calls, generation then audit, the same
as the vignette path. The reasoning recorded for the vignette audit above applies
unchanged: generation latency, not request count, keeps a hosted run under 20/min. Worth
confirming on a 100-card deck on the hosted route.

**Skip rate.** The prompt lets the model skip a card with nothing to apply. Two failure
modes to watch for, in opposite directions: skipping cards that state a rule, cause or
behaviour (the prompt tells it not to — if it does anyway, tighten the escape hatch), and
forcing scenarios onto names and dates (loosen it). Record the skip rate per fixture
deck here.

**Audit reject rate.** As with the vignette audit: too high means the audit is too
strict; never rejecting a planted bad question means it is too lax. The stubbed
generator test in the harness checks the plumbing; only a real run checks the judgement.

## 2026-09-19 — application questions: four prompt fixes and the render-and-commit fixture

A read-through of real application questions from a React slide deck found four failures, each now
addressed in `APPLICATION_SYSTEM_PROMPT` and `APPLICATION_AUDIT_SYSTEM_PROMPT`:

1. **Restated, not applied.** A scenario narrated "React re-renders, then commits" and the stem asked
   what happens after commit — the card read back. The prompt now requires the answer to depend on
   a particular of the scenario ("cover the scenario"), and the audit gained an APPLIED check.
2. **Forced scenarios for sequences.** The escape hatch told the model not to skip "a procedure",
   which it read as licence to wrap a fixed sequence in a story. Sequences, analogies, terms and
   API names are now listed as skips; a procedure counts as applicable only when the student must
   decide what happens next.
3. **The card's own example, renamed.** A card built on the docs' Clock example (an `<h1>` and an
   `<input>`) produced a Timer with a `<p>` and a `<textarea>`. The prompt now forbids swapped-name
   copies of the card's or the textbook's example, and the audit gained a NEW check.
4. **Options checked against one card.** A question about which component React calls ignored a
   neighbouring card saying rendering recurses into children. The prompt now checks options against
   every card given, and the audit's ONE RIGHT ANSWER check names every related card. The audit's
   context also now includes every card in the batch: `contextCards` excludes the batch, so a
   sibling card — or one the model skipped — was invisible to it.

**The fixture.** `tools/fixtures/render-and-commit-cards.json` is that deck, each card annotated with
the verdict it should get: 9 apply, 10 skip, 5 either. Running `tools/test-application.mjs` with a
key and this fixture prints skip and apply agreement and the three known traps (c11, c17, c23).
Record each run's numbers here.

### Fixture runs, 2026-09-19 (claude-sonnet-5)

**Run 1 — audit ceiling still 1000.** 13 questions, 9 skipped, 2 failed, of 24 cards.
Skipped as expected 9/10, applied as expected 9/9. Two of the three audit batches came
back `stopReason=max_tokens` with no verdict for any of their five questions, so both
batches were dropped whole and retried; the two card failures were the residue. A
truncated audit is indistinguishable from a unanimous rejection except by the
`missingVerdict`/`stopReason` reporting added when the audit was written — which is what
caught it.

**Ceiling raised: `application-audit` 1000 -> 4000** (client and server copies). 1000 was
borrowed from `vignette-audit` on the reasoning that both replies are verdict lists. It
no longer holds: six checks reason over more than four did, and the reply runs past 1000
before it reaches the JSON.

**Run 2 — audit ceiling 4000.** 14 questions, 10 skipped, 0 failed, of 24 cards. All three
audits ended `end_turn` with every verdict present, flagging 1 of 4, 1 of 3 and 1 of 5 —
judgement rather than truncation. Skipped as expected 9/10, applied as expected 9/9.

| | run 1 | run 2 | aim |
|---|---|---|---|
| skipped as expected | 9/10 | 9/10 | >= 8/10 |
| applied as expected | 9/9 | 9/9 | >= 8/9 |
| failed cards | 2 | 0 | 0 |
| audits truncated | 2 of 3 | 0 of 3 | 0 |

**The traps.** c17 skipped in both runs — the sequence fix holds. c11 came back consistent
with c10 in both runs: the marked answer is the component whose state updated, and no
option names the parent and then its child, so nothing defensible is marked wrong.

**Still open after these fixes:**

- **c23 defeats the NEW check.** Run 2 produced "a weather widget re-renders every 5
  seconds to show the latest temperature in a `<span>`, while a text `<input>` ... sits in
  the same spot in the JSX". That is the docs' Clock example with the names swapped —
  clock to weather widget, `<h1>` to `<span>`, time to temperature — which is exactly what
  the NEW rule and the audit's NEW check forbid. Changing the elements and the subject
  noun is evidently not read as changing "what the situation is about" when the *shape*
  (something on a timer beside a text input) is preserved. The next attempt should name
  the shape, not just the names: forbid re-using the card's arrangement of parts.
- **c19 is forced in both runs.** "What can you use to find mistakes in your React
  components?" -> "Strict Mode" is a card whose answer is a name, and both runs wrapped it
  in an impure-component story ending "which React feature would help the developer notice
  this bug ... ?". The skip list names "what something is called"; the model appears to
  treat a feature that *does* something as applicable regardless. Note that the resulting
  question is not a bad one — it is just recall of a name with scenery.

### Fixture runs, round 2 (claude-sonnet-5)

The round-2 changes: NEW compares *structure* rather than names in both the generation
bullet and audit check 6; APPLIED now fails a question whose answer is the name of a
tool, feature, API or term; the escape hatch names feature-and-tool cards as skips; and
the audit reply carries `"failed": [string]`, so a rejection says which checks did it.
c23's fixture verdict moved from `apply` to `either` — it is a worked example of c12's
rule, and c12 can carry the application question.

| | run A | run B | aim |
|---|---|---|---|
| skipped as expected | 10/10 | 10/10 | >= 8/10 |
| applied as expected | 8/8 | 8/8 | >= 7/8 |
| failed cards | 2 (c21, c23) | 1 (c9) | 0 |
| audits truncated | 0 of 2 | 0 of 3 | 0 |
| questions / skipped | 11 / 11 | 11 / 12 | — |

**Per-check rejections**, read off the audit warnings (real-model batches only):

- Run A: `NEW 3` in one batch, `NEW 2` in another. Five rejections, all NEW.
- Run B: `APPLIED 1, NEW 1`; then `NEW 2`; then `NEW 1`. Five rejections, four NEW and
  one APPLIED.

Ten rejections across the two runs, nine of them NEW. The named-check field is doing
exactly the job it was added for: before it, this would have read as "five flagged" with
no way to tell a strict prompt from one rule doing all the work.

**Audit output tokens per call:** not recorded. `callModel` returns `{ text, stopReason }`
only (src/lib/aiTransport.ts), and adding usage plumbing was out of scope for this round.

**c19 — skipped in both runs.** The APPLIED sentence about names, and the escape hatch's
feature-and-tool clause, hold. Round 1 forced it into an impure-component story twice.

**c23 — one rejection, one rename.** Not fixed.

- Run A: no question. The audit rejected its scenario on NEW, the retry too, and the card
  ended as a failure rather than a skip.
- Run B, accepted and shipped, verbatim: "A dashboard component re-renders every second
  to show a live stock price, while a `<textarea>` next to it lets the user jot notes. As
  the price updates, the notes the user is typing never disappear." Q: "Based on how
  React handles commits, why does the text in the textarea stay intact across these
  re-renders?" Correct: "React only updates the DOM where the output differs, so the
  unchanged textarea node is left alone."

That is the Clock example again — a value on a timer beside a text field the user types
into — with every part renamed and the structure untouched, which is precisely what the
round-2 wording forbids. Wording that names the failure this explicitly still did not
prevent it in one run of two. Worth noting it was *not* rescued by an untaught fact: the
question is grounded in c12, and no variant tried to test what happens when the input
moves position. The open question is therefore not how to phrase NEW, but whether a card
that *is* a worked example should be skipped outright.

**A blind spot in the scoring.** "Applied as expected" counts only apply-cards the model
chose to *skip*; a card whose question the audit rejected to death is not counted, because
it is not in `notApplicableCardIds`. Run B scored 8/8 while c9 ("What does React do in
Strict Mode…", an apply card) produced no question at all. Read the failed-card count
beside the applied figure, not instead of it.

## 2026-09-19 — card prompt: yes/no fronts, one-answer fronts, paraphrased repeats

Three patterns found in a real React slide deck (now `tools/fixtures/render-and-commit-cards.json`)
that the card prompt did not address:

- **Near-duplicates in different words.** "What are the three steps involved in React displaying UI
  on screen?" and "What are the three steps that happen during any screen update in a React app?"
  score 0.67 / 0.67 — far below the 0.9 / 0.9 dedupe threshold, which is deliberate (see "What this
  deliberately does not catch" above). Rule 7 now says one fact gets one card however it is worded,
  within a section as well as across sections.
- **Yes/no fronts.** "Does React touch the DOM if the rendering result is the same as last time?"
  restated another card's rule as a coin toss. Rule 3 now forbids yes/no questions.
- **Many-answer fronts.** "What can you use to find mistakes in your React components?" → "Strict
  Mode." has many correct answers. New rule 8 requires one.

**What a prompt cannot fix.** Rule 7 only sees the sections in one request (`BATCH_SIZE = 4`
sections in `aiGenerator.ts`). An intro slide and a recap slide drafted in different requests can
still produce the same card twice. Catching that needs a meaning-based pass over the whole deck
after drafting; it is not part of this change. To measure: re-draft the source of the fixture deck
and count repeated facts, yes/no fronts and many-answer fronts, before and after.

**Before and after, measured.** Source: <https://react.dev/learn/render-and-commit>, parsed by the
app's own pipeline (`sectionsFromDocument` -> `generateCandidatesWithAi`, 6 sections,
claude-sonnet-5). "Before" is the 24-card fixture; "after" is one drafting run with rules 3, 7 and
8 in place. One run each side — a read-through, not a statistic.

| | before | after |
|---|---|---|
| total cards | 24 | 19 |
| repeated facts | 3 pairs | 1 pair, plus 1 reversal |
| yes/no fronts | 1 | 0 |
| many-answer fronts | 1 | 1 |

- **Yes/no fronts: fixed.** No front in the new draft opens with does/is/can/will. c15, the
  coin-toss restatement of c12, has no counterpart.
- **Repeats: improved, not solved.** "What are the three steps involved in React displaying a
  component on screen?" and "What are the three steps that occur for any screen update in a React
  app?" both came back, with the identical answer "Trigger, Render, and Commit." — the c3/c7 pair
  again, from sections drafted in different requests. That is the limit named just above, not a
  rule 7 failure. A softer repeat survives too: "Why does React call each component's function
  twice in Strict Mode?" beside "What tool can help find mistakes in your React components?" ->
  "Strict Mode." is the c9/c19 reversal.
- **Many-answer fronts: not fixed.** "What tool can help find mistakes in your React components?"
  -> "Strict Mode." survived rule 8 almost verbatim. ESLint, the profiler and a type checker all
  answer it. Rule 8's example did not transfer to this card.

**The total fell 24 -> 19, and the lost cards matter.** Rule 7 merged cards that differ:

- The three cooking/restaurant analogy cards (c2, c4, c14) produced no counterpart at all.
- The "painting" terminology card (c6), the commented-out `root.render()` card (c21) and the
  "update state to trigger a re-render" card (c24) are gone.
- Two pairs became one card each: initial-render and re-render callee (c18 + c11), and both purity
  rules (c5 + c13) in a single two-part answer — rule 1 ATOMIC giving way to rule 7.

Three cards are new, two of them weak in ways no rule covers: "In this example, which functions
does React call while rendering the Gallery component..." leans on "this example" against rule 2,
and "What does the diagram of the browser painting step depict?" tests a figure rather than a fact.

**Reading it whole:** rule 3 worked, rule 7 helped within a request and cost distinct facts
elsewhere, and rule 8 did not bite. The next wording to change is rule 8's, not rule 7's.

### Round 3: audit-confirmed skips, NEW scoped to described examples

Round 2 met the skip and apply aims but not the failed-card aim (2 and 1 against 0), and nine
of its ten audit rejections were NEW. Three changes follow from that:

- **Audit check 6 is scoped to examples the cards describe.** Round 2's wording asked the audit
  to compare every scenario with "the well-known example of the idea", while the generation
  rule only asks about cards built on an example. The audit therefore imagined a canonical
  example for rule cards too, and two rule cards (c9, Strict Mode; c21, `root.render()`) ended
  with no question. NEW now compares a scenario only with examples a card actually describes —
  the question's own card or any related card — which is also something the audit can check,
  where "the well-known example" was its memory.
- **Audit-confirmed skips.** A card whose question the audit rejects in both passes, each time
  only on APPLIED or NEW, is recorded as a skip instead of a failure. As a failure it was
  offered again on every visit to the setup screen and charged for again. A rejection on
  CORRECT or ONE RIGHT ANSWER, or no verdict at all, still leaves a failure: those describe the
  question, not the card.
- **Every rejection is visible.** `onAuditReject` reports each rejected question with its named
  checks; `tools/test-application.mjs` prints them on a real run. "Applied as expected" now
  counts apply cards that got a question, and lists LOST cards (no question, not skipped)
  separately.

**Risk to watch:** an audit-confirmed skip persists until the card is edited. If NEW still
over-reaches, an apply card can be skipped for good. That shows up as a DODGED apply card in
the fixture run; read its REJECTED entries before accepting the numbers.

### Fixture runs, round 3 (claude-sonnet-5)

Two runs of `tools/test-application.mjs` against `tools/fixtures/render-and-commit-cards.json`,
with check 6 scoped to described examples, audit-confirmed skips, and the rejection printout.

| | run A | run B | aim |
|---|---|---|---|
| skipped as expected | 10/10 | 10/10 | >= 8/10 |
| applied as expected (got a question) | 8/8 | 8/8 | >= 7/8 |
| lost apply cards | 0 | 0 | 0 |
| failed cards | 0 | 0 | 0 |
| audits truncated | 0 | 0 | 0 |
| questions / skipped | 12 / 12 | 11 / 13 | — |

Every aim met in both runs. Round 2's failed cards (2 and 1, against an aim of 0) are gone.

**Per-check rejections**, real-model batches only — the stubbed sections' warnings are not
counted:

- Run A: `APPLIED 1` (c8), then `NEW 1` (c23). Two rejections.
- Run B: `NEW 2` (c21, c23), then `NEW 1` (c23 again). Three rejections, all NEW.

Five rejections across two runs against round 2's ten. The NEW share barely moved (4/5 against
9/10); what changed is that there are half as many rejections to share out.

**c9 and c21 both got a question in both runs.** These are the two rule cards round 2 lost to an
imagined canonical example, and the reason check 6 was scoped.

**"either" cards:**

| card | run A | run B |
|---|---|---|
| c8 | skipped | skipped |
| c15 | question | question |
| c18 | skipped | skipped |
| c21 | question | question |
| c22 | question | question |
| c23 | question | skipped (audit-confirmed) |

**Were the rejections fair?** Read before the numbers, as the plan requires. All five describe
the card rather than an example the audit imagined:

- **c8 [APPLIED], run A.** The scenario put a `console.log` in a component and asked what React
  is doing when it fires; the answer, "calling the component function to determine what should
  be displayed", is the card's own definition of rendering with scenery around it. Fair.
- **c23 [NEW], three times.** Each scenario re-ran the Clock example with the parts renamed: a
  stopwatch with a `<textarea>` (run A), a dashboard with a checkbox and a cart with a
  gift-message `<input>` (run B). Same trigger, same roles. Fair — and this is exactly the
  protection the scoping was meant to keep.
- **c21 [NEW], run B.** The scenario moved `root.render()` into an onClick handler instead of
  commenting it out. Borderline: the trigger differs, but the mechanism is the card's own. It
  cost nothing — the retry was accepted.

No rejection was unfair, and no apply card was DODGED in either run, so the first stopping rule
does not apply.

**c23 — still accepted renamed in one run of two.** Verbatim:

- **Run A, accepted:** "A weather widget re-renders every 5 seconds with a new temperature prop.
  Its JSX includes an `<h2>` showing the temperature and, in the same position each render, a
  `<select>` dropdown for choosing a city. A user picks 'Paris' from the dropdown just before the
  next update fires." — Q: "What happens to the dropdown's selected value after the next render?"
  That is the Clock example with `<h1>`/`<input>` renamed to `<h2>`/`<select>`, accepted after the
  stopwatch version was rejected on NEW.
- **Run B:** rejected twice on NEW and recorded as an audit-confirmed skip — the new mechanism
  doing its job, and an acceptable outcome for an `either` card.

Per the plan's second stopping rule, this is audit judgement varying between runs rather than a
wording problem: recorded, and left alone.
