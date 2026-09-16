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
| `infographic-basic` | 4000 |
| `infographic-standard` | 6000 |
| `infographic-detailed` | 8000 |

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

**Infographic — why 4000 for Basic, 6000 for Standard, 8000 for Detailed.** The response is compact structured JSON — a title plus a set of typed blocks (bullets, timeline, table, callout, stat, compare, steps, quote), not prose — but the richer block types cost more JSON per block than a plain bullets section did: a table's nested row arrays and a compare block's two point lists are each several short strings where a bullets block is one. Standard was raised from 4000 to 6000 because it can carry up to 6 blocks of any type, including the denser ones, and was hitting the same mid-JSON truncation this section's Quiz entry above already flagged. Detailed didn't need to move off 8000: its total-block ceiling of 10 is actually *lower* than the old 14-section ceiling it replaced, and that drop offsets the added per-block verbosity.

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
