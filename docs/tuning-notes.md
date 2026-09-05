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

**Open, not yet done:** none of this has been run against real output. Before trusting
it: run cards against `tools/fixtures/pages/*.html` and a list-heavy source; run both
quiz styles on a real clinical deck and watch the audit pass's actual reject rate (too
high means its own prompt is too strict; never rejecting even an obviously bad planted
distractor means it's too lax to trust); and — since none of this had a temperature set
before, and still doesn't — if a lower temperature is tried, score it by the audit
pass's flag count rather than by eye alone, and record the result here either way.
