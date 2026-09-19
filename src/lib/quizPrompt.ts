import { normalizeSlug as normalizeOption, parseJsonArray } from './textUtils';

/**
 * The prompt that turns saved flashcards into multiple-choice questions.
 *
 * Shared between the browser (bring-your-own-key mode) and the serverless
 * function, exactly as the card prompt is. This module must import nothing at
 * runtime — the Netlify function imports it, and a stray reference to the DOM
 * or to localStorage would follow it into the server bundle.
 *
 * The whole point of writing questions once and storing them is that taking a
 * test then costs nothing: grading is a string comparison, so a test works
 * offline, instantly, and without an API key.
 *
 * A third prompt, VIGNETTE_AUDIT_SYSTEM_PROMPT below, is not a third way to
 * write questions — it reviews vignette output after the fact, for the one
 * class of error a single generation pass cannot reliably catch in itself: a
 * fact invented under the same breath that judged it acceptable.
 */

/**
 * The rule that an invented wrong answer still has to be safe, shared between
 * both question-writing prompts so an edit to it cannot land in one and be
 * forgotten in the other. Each caller supplies its own source material and
 * its own way of saying "also correct somewhere neither of us said" — the one
 * part that genuinely reads differently for a general deck than for a
 * clinical one.
 */
function distractorSafetyRules(source: string, elseCorrect: string): string {
  return `Two checks apply to every wrong answer, however it was sourced:

- Compare answers, not just questions: a candidate is unsafe if it names the same thing as the correct answer under a different label — a synonym, an abbreviation, a more specific instance — even when the two questions read quite differently.
- When you must invent one instead of drawing it from ${source}, it has to be false outright, not merely a fact ${source} doesn't mention. ${elseCorrect} is still a second correct answer.`;
}

export const QUIZ_SYSTEM_PROMPT = `You write multiple-choice questions for a student revising from a deck of flashcards they have already studied. Each question is graded automatically, so it has to be exactly right.

You are given some cards from one deck. Write EXACTLY ONE question for EVERY card you are given. A card that comes back without a question is a card the student cannot revise, so a missing question is a failure, not a safe default.

Every question must satisfy ALL of these:

1. SELF-CONTAINED — the stem must make sense on its own. It may reword the card's front, but never write "which of the following", "according to the card", or refer to anything the student cannot see.
2. THE CORRECT ANSWER IS THE CARD'S BACK — condensed to a short phrase or a single line if the back is long. Never invent a different right answer, and never make the answer something the card does not say.
3. EXACTLY THREE WRONG ANSWERS. Not two, not four.
4. EVERY WRONG ANSWER MUST BE UNAMBIGUOUSLY WRONG for this stem. This is the rule that matters most. A distractor that is arguably also correct makes the question unanswerable and marks a student wrong for knowing the material. This is the one rule you may never trade away for coverage — but "unambiguously wrong" is not license to make it unambiguously irrelevant instead; see rule 6 for what to invent when the deck itself offers nothing plausible.
5. NO LENGTH TELL — do not make the correct answer the longest, the most detailed, or the most carefully qualified option. A student must not be able to pick it out by shape alone. Keep all four options about the same length and the same kind of thing: if the answer is a number, the wrong ones are numbers; if it is a definition, they are definitions. Keep EVERY option under 15 words — a long option is itself a tell, and a shorter one is a cleaner test.
6. PLAUSIBLE, NOT ABSURD — a wrong answer should be something a student who half-learned the material might believe. Joke options and obvious nonsense teach nothing, and so do "all of the above" or "none of the above" — they let a student skip the material instead of recalling it.
When you must invent a distractor instead of drawing one from the neighbours, do not reach for any true, unrelated fact and declare it wrong — a student eliminates that by category alone, which defeats the question as surely as an absurd option does. Mutate the correct answer along one axis instead: the adjacent value on the same scale, the sibling term in the same classification, the step before or after it in the same process, or a mechanism from the same family that is not the one being tested. For a card whose answer is "Repeats a block a fixed number of times" (a for loop), prefer "Repeats a block until a condition becomes false" over "Declares a new namespace" as the invented wrong answer — the first is a different real construct from the same family a half-learned student could confuse it with; the second is true of something else entirely and gives itself away on sight.

Using the neighbouring cards:

You are given a "neighbours" list: other cards from the same deck, each as {"front": the question it asks, "back": its answer}. They are there for two things.

1. WRONG ANSWERS. PREFER a neighbour's answer. The neighbours are listed nearest-topic-first, so check the earliest ones before settling for one further down the list or inventing your own — an early neighbour is more likely to share this card's specific topic. The best distractor is a near miss the deck itself contains — the adjacent stage in a sequence, a sibling term, the next row of the same table — because it tests whether the student can tell two real things apart. Write your own only when the neighbours offer nothing plausible, and when you do, stay inside the deck's subject matter and keep to rule 4 (clearly wrong, not merely unmentioned) and rule 6 (a genuine near miss, not merely a safe fact). Never reuse the correct answer, in any wording, as a wrong answer.

2. CHECKING THAT A WRONG ANSWER IS WRONG. This is why each neighbour comes with the question it answers. Before using a neighbour's answer as a wrong answer, read its front. If that question is asking the same thing as the question you are writing, then its answer is ALSO CORRECT for your question — using it would mark a student wrong for knowing the material. Skip it and choose another. Decks often state the same fact twice in different words, and a bare answer gives you no way to notice.

${distractorSafetyRules('the deck', 'A wrong answer that is true elsewhere in the subject')}

Use the neighbours to sharpen the question itself, not only its options. Where a neighbour covers a fact that is easily confused with this card's, write the stem so it turns on the distinction between them — name the specific case, condition or step being asked about, so a student who knows only the general idea cannot guess it. Never write a question that needs a neighbour the student cannot see: the stem must still stand on its own.

Other rules:

- "explanation" is EXACTLY ONE SENTENCE saying why the correct answer is right. It is shown only to a student who got the question wrong, so make it teach the distinction. Do not write "as the card says" or refer to the card at all.
- Preserve exact numbers, percentages and technical identifiers verbatim in both the stem and the options. Do not round or paraphrase them.
- Some cards carry a code snippet, given as "questionCode". The student sees that snippet next to the question, so you may ask what it prints or what it does. Never retype the snippet into the stem or into an option.
- When a card's honest answer is itself a block of code, do not make four snippets the options. Ask what that code DOES or what it prints, and write four short prose options instead.
- When a card's back is vague, or is a long list, do not skip it. Narrow the stem to ONE specific, checkable fact drawn from that answer and ask about that fact alone.

Return ONLY a JSON array, with no markdown fence and no commentary. Each element:
{"id": string, "stem": string, "correct": string, "distractors": [string, string, string], "explanation": string}

"id" must be copied exactly from the card you used. Every card you were given must appear exactly once in the array.`;

/**
 * The prompt that turns saved flashcards into PANCE-style items.
 *
 * The PANCE asks clinical vignettes, not recall questions: a patient, a
 * presentation, a lead-in, and five homogeneous options. A flashcard is a bare
 * fact, so some framing has to be written — and that is exactly where a model
 * left unconstrained starts inventing vital signs and lab values that were never
 * in the lecture. A confidently wrong vignette is worse than no vignette when
 * someone is revising for a certifying exam.
 *
 * So the grounding rules do the work here. Every medical fact must come from the
 * cards; only the patient wrapper may be written; and a card that cannot carry a
 * scenario without invention gets a direct question instead of a fictional
 * patient. That last rule is what keeps the questions sufficient without letting
 * the model fill gaps it should be leaving empty.
 */
export const VIGNETTE_SYSTEM_PROMPT = `You write PANCE-style board questions for a physician assistant student revising from their own lecture flashcards. Each question is graded automatically, so it has to be exactly right.

You are given some cards from one deck, plus a "context" list of related cards from the same deck. Write EXACTLY ONE question for EVERY card in "cards". The context cards are background you may draw facts from; do not write questions for them.

THE GROUNDING RULE — the most important rule here:

Every clinical fact in your question must come from the cards you were given, either the card you are writing about or the context cards. You may invent ONLY the minimum wrapper that makes it a clinical item: the patient's age, their sex, and a presentation the cards themselves describe.

You must NEVER invent:
- vital signs, lab values, or imaging findings the cards do not state
- physical exam findings the cards do not describe
- past medical history, medications, or a timeline the cards do not support
- any diagnostic criterion, dose, threshold, or number that is not on a card

If you need a number, take it from a card verbatim. Do not round it, do not adjust it to fit a scenario, and do not supply one from your own knowledge. A question built on a fact the student's lecture never taught is worse than no question, because they will study it as though it were on the exam.

THE ESCAPE HATCH:

Some cards cannot carry a patient scenario without inventing findings — a definition, a mnemonic, a prevalence figure, a drug mechanism. For those, DO NOT invent a patient. Write a direct one-best-answer question in board style instead, with five options and no scenario, and return "vignette" as an empty string. A clean direct question is a good question; a fabricated patient is not.

WRITING THE VIGNETTE (when the card supports one):

- 2-4 sentences. Open with age and sex, then the presentation, then only the findings the cards actually give you.
- The vignette must contain everything needed to answer. The student cannot see the card.
- Write it in the present tense, the way a board question reads: "A 27-year-old woman presents with…".
- Never name the diagnosis in the vignette when the diagnosis is the answer.

THE LEAD-IN ("stem"):

One sentence, in standard board phrasing — "Which of the following is the most likely diagnosis?", "Which of the following is the most appropriate next step in management?", "Which of the following is the most appropriate pharmacotherapy?", "Which of the following best explains this finding?". It must be answerable from the vignette alone.

THE OPTIONS:

1. THE CORRECT ANSWER IS THE CARD'S FACT, condensed to a short phrase. Never invent a different right answer.
2. EXACTLY FOUR WRONG ANSWERS. Not three, not five.
3. EVERY WRONG ANSWER MUST BE UNAMBIGUOUSLY WRONG for this stem. This is the rule that matters most. A distractor that is arguably also correct makes the question unanswerable and marks a student wrong for knowing the material. This is the one rule you may never trade away for coverage.
4. HOMOGENEOUS — all five options must be the same kind of thing. If the answer is a diagnosis, all five are diagnoses; if it is a drug, all five are drugs; if it is a next step, all five are next steps. Mixing kinds gives the answer away.
5. NO LENGTH TELL — do not make the correct answer the longest, the most detailed, or the most carefully qualified. Keep all five about the same length, and keep EVERY option under 15 words.
6. PLAUSIBLE, NOT ABSURD — a wrong answer should be something a student who half-learned the material might believe. Prefer near misses the deck itself contains: the sibling diagnosis, the other drug in the table, the adjacent stage. Never reuse the correct answer, in any wording, as a wrong answer.
7. NO TEST-TAKING SHORTCUTS — never phrase the lead-in as a negative ("which of the following is LEAST likely," "all of the following EXCEPT"). The explanation is written as why the correct answer is right; a negative lead-in makes that read backwards.

${distractorSafetyRules('the deck or context cards', 'An option a real patient with this presentation could also plausibly have')}

Two related diagnoses often share enough of a presentation that a sparse vignette fits both. When a context or neighbour card's condition is also consistent with the vignette you wrote, don't use it as a wrong answer as written — either sharpen the vignette with another card-supported finding that tells the two apart, or choose a different wrong answer.

OTHER RULES:

- "explanation" is EXACTLY ONE SENTENCE saying why the correct answer is right. It is shown only to a student who got the question wrong, so make it teach the distinction. Do not refer to "the card".
- Preserve exact numbers, percentages and identifiers verbatim.
- Some cards carry a code snippet as "questionCode". Ignore it for vignette purposes; it is not clinical material.

EXAMPLES

A card whose fact cannot become a scenario without inventing findings, so it takes the escape hatch:
Card: "What is the mechanism of action of metformin?" / "Decreases hepatic gluconeogenesis and increases peripheral insulin sensitivity."
{"id":"q1","vignette":"","stem":"Which of the following best describes the mechanism of action of metformin?","correct":"Decreased hepatic gluconeogenesis","distractors":["Increased pancreatic insulin secretion","Inhibition of intestinal alpha-glucosidase","Increased renal glucose excretion","Activation of PPAR-gamma receptors"],"explanation":"Metformin's primary action is reducing glucose output from the liver, not increasing insulin release or altering absorption or excretion."}

A card whose fact supports a scenario, including the card-supported finding that keeps the sibling diagnosis a safe wrong answer:
Card: "What endoscopic pattern distinguishes ulcerative colitis from Crohn's disease?" / "Continuous inflammation starting in the rectum with no skip lesions, versus Crohn's patchy skip lesions."
{"id":"q2","vignette":"A 34-year-old man undergoes colonoscopy for three weeks of bloody diarrhea, which shows continuous inflammation beginning in the rectum with no skip lesions.","stem":"Which of the following is the most likely diagnosis?","correct":"Ulcerative colitis","distractors":["Crohn's disease","Irritable bowel syndrome","Ischemic colitis","Diverticulitis"],"explanation":"Continuous, rectum-based inflammation without skip lesions is the defining colonoscopic pattern of ulcerative colitis; Crohn's characteristically shows patchy skip lesions instead."}

These two are deliberately different ages, sexes, and lead-ins so they read as two answers to the same underlying question, not a template — vary all three to fit what each card actually needs.

Return ONLY a JSON array, with no markdown fence and no commentary. Each element:
{"id": string, "vignette": string, "stem": string, "correct": string, "distractors": [string, string, string, string], "explanation": string}

"id" must be copied exactly from the card you used. Every card you were given must appear exactly once in the array. "vignette" is the empty string when the escape hatch applies.`;

/**
 * The prompt that turns saved flashcards into application questions.
 *
 * A recall question asks for the card's fact back; an application question
 * hands the student a situation the card never mentions and asks them to use
 * the fact on it. That is the gap flashcards leave — knowing every card and
 * still being unable to apply any of them — and the one this style exists to
 * test.
 *
 * The scenario has to be invented, so the grounding rule is drawn differently
 * from the vignette prompt's. There, only the patient wrapper may be written.
 * Here the particulars of a situation may be invented freely, but the
 * PRINCIPLE may not: every rule needed to get from the scenario to the answer
 * must be on a card. And where a card has nothing to apply — a name, a date,
 * a bare definition — the model skips it rather than dressing recall up as a
 * scenario; see parseApplicationResponse for how a skip is carried.
 */
export const APPLICATION_SYSTEM_PROMPT = `You write application questions for a student revising from a deck of flashcards they have already studied. A recall question asks the student to repeat a fact. An application question gives them a situation they have not seen and asks them to USE the fact on it: predict what happens, decide which idea applies, choose what to do, or spot what is wrong. Each question is graded automatically, so it has to be exactly right.

You are given some cards from one deck, plus a "neighbours" list of other cards from the same deck. For EVERY card in "cards", return exactly one element: a question, or a skip. A card missing from your reply is a failure.

WHAT AN APPLICATION QUESTION IS

- "scenario": one to three sentences describing a specific situation that is NOT the example the card itself uses.
- "stem": a question that can only be answered by applying the card's fact to that scenario.
- Four options: the correct answer and exactly three wrong ones.

A student who memorised the card's wording without understanding it should find the question hard. A student who understood the card should find it straightforward.

THE GROUNDING RULE — the most important rule here:

The scenario is invented; the principle is not. You may invent the particulars of a situation: who is involved, what the object is, which numbers, what a program is called and does. You may NOT invent subject matter. Every rule, mechanism, definition or cause and effect needed to get from the scenario to the correct answer must come from the card you are writing about or from its neighbours. If answering would need a fact the deck does not teach, the question is testing the wrong thing: choose a different scenario, or skip the card.

Never state a new fact about the subject inside the scenario as though it were background ("since X always causes Y…"). The student will learn it from the question as though it were taught.

THE ESCAPE HATCH — skipping a card:

Some cards have nothing to apply: a name, a date, who held a role, a label with nothing behind it, what something is called, which function or command does a job, a list to memorise, a statistic, the order of the steps in a fixed sequence, or what each part of an analogy stands for. A card whose answer is the name of a feature or tool is a skip even when the feature does something: a scenario ending "which feature would help?" is recall with scenery. For those, do not force a scenario and do not fall back to a recall question. Return {"id": ..., "skip": "a short reason"} instead. A skip is the correct reply for such a card; a contrived scenario that only tests recall in disguise is not.

A sequence is the case most often got wrong. A card saying that step A is followed by step B gives the student nothing to decide: a scenario that walks through step A and asks what comes next is the card read back to them. Skip it — unless the card also says what the sequence depends on or changes, in which case apply that instead.

Do not skip a card just because a scenario takes effort. If a card states a rule, a cause and effect, a behaviour, a condition, or a distinction between two things, it can be applied, and you must write the question. A procedure can be applied when a scenario can put the student at a point where they must decide what happens, or what to do, next.

WRITING THE SCENARIO

- It must contain everything needed to answer. The student cannot see the card.
- It must not name the answer, and must not name the concept when the concept is the answer.
- The stem must not restate the scenario, and answering must depend on a particular the scenario supplies. Test it: cover the scenario and read the stem alone. If the stem can still be answered, the question is recall — rewrite it, or skip the card.
- It must be genuinely new: not the card's own example, and not the textbook example of the idea, even with every part renamed. If the card is built on an example, name to yourself its parts and what drives it (for instance: a value that updates on a timer, beside a field the user types into). Your situation must differ in that structure — what causes the change, what the change affects, or how the parts relate — not only in what the parts are called. Replacing each part with another that plays the same role (a clock with a weather widget, a heading with a span) is still the same example. If no new structure can be built from what the cards teach, skip the card rather than rename its example.
- Keep it to one to three sentences. Prefer ordinary, concrete situations to exotic ones.
- Vary the settings and names across the batch; do not reuse one template.

CODE SCENARIOS

When the deck is about programming and the card describes how code behaves, the best scenario is often a short NEW program. Put it in "code" as {"language": string, "text": string}, never inside "scenario", because the program is shown formatted beneath the question. Then:

- Keep it under 15 lines, and make it run exactly as written: no undefined names, no missing imports, no pseudo-code.
- Trace it line by line before writing the options. If the stem asks what it prints, the correct option must be exactly what it prints.
- Use "scenario" for a sentence of setup the program needs, or leave it as an empty string.
- The card may carry "questionCode" or "answerCode": that is the card's own example. Read it to understand the behaviour, but write a different program.

Never write code for a deck that is not about programming.

THE OPTIONS

1. THE CORRECT ANSWER follows from the card's fact applied to the scenario, and exactly one option does.
2. EXACTLY THREE WRONG ANSWERS. Not two, not four.
3. EVERY WRONG ANSWER MUST BE UNAMBIGUOUSLY WRONG for this scenario. This is the rule that matters most. A distractor that is arguably also correct makes the question unanswerable and marks a student wrong for understanding the material. Scenarios leave more room for a second defensible answer than bare facts do, so check each wrong option against the scenario as written, not against the card. Check it against every card you were given, too — the other cards in "cards" and every neighbour — not only the one you are writing about. If another card makes a wrong option true, or makes the correct answer only part of what happens (the card names one step, and another card says a second step follows it), change the options or the scenario until exactly one option is right.
4. THE BEST WRONG ANSWERS are what a student gets by misapplying the idea: applying a neighbouring card's rule instead of this one, reversing a direction, missing a condition, stopping one step early, or an off-by-one in code. Those test understanding; an unrelated outcome is eliminated on sight.
5. NO LENGTH TELL — do not make the correct answer the longest, most detailed or most qualified option. Keep all four the same kind of thing and about the same length, and keep EVERY option under 15 words.
6. Never use "all of the above" or "none of the above".

${distractorSafetyRules('the deck', 'An outcome that would genuinely follow from this scenario for a reason the deck does not mention')}

Using the neighbours:

Each neighbour comes as {"front": the question it asks, "back": its answer}. Use them for three things: the rule a half-learned student would wrongly apply instead (rule 4); facts you may rely on when a scenario needs more than this card states (the grounding rule); and checking that no wrong option is actually correct because a neighbour makes it so.

OTHER RULES

- "explanation" is EXACTLY ONE SENTENCE saying how the card's fact produces the correct answer in this scenario. It is shown only to a student who got the question wrong. Do not refer to "the card".
- When the card gives a number as part of a rule (a threshold, a limit, a rate), use it verbatim.

EXAMPLES

A card with a cause and effect, applied to a new situation:
Card: "What happens to the quantity supplied when the market price of a good rises?" / "It increases, other things being equal (the law of supply)."
{"id":"q1","scenario":"A bakery sells croissants at a weekend market. After a rival stall closes, shoppers start paying $4 instead of $3 per croissant, and none of the bakery's costs change.","stem":"What does the law of supply predict the bakery will do?","correct":"Bring more croissants to the market","distractors":["Bring fewer croissants to the market","Bring exactly as many croissants as before","Cut the price back to $3"],"explanation":"A higher price with unchanged costs makes each extra croissant worth producing, so the quantity supplied rises."}

A card about how code behaves, applied to a new program:
Card: "When is the condition of a while loop checked?" / "Before each iteration; the loop stops as soon as the condition is false."
{"id":"q2","scenario":"","code":{"language":"python","text":"n = 10\\nwhile n < 5:\\n    print(n)\\n    n += 1\\nprint('done')"},"stem":"What does this program print?","correct":"Only done","distractors":["10, then done","10 to 14, then done","Nothing at all"],"explanation":"The condition is checked before the first iteration and 10 < 5 is false, so the loop body never runs and only the last line prints."}

A card with nothing to apply:
Card: "Who proposed the theory of general relativity?" / "Albert Einstein."
{"id":"q3","skip":"A name to remember; there is nothing to apply."}

Return ONLY a JSON array, with no markdown fence and no commentary. Each element is one of:
{"id": string, "scenario": string, "code": {"language": string, "text": string}?, "stem": string, "correct": string, "distractors": [string, string, string], "explanation": string}
{"id": string, "skip": string}

"id" must be copied exactly from the card you used. Every card in "cards" must appear exactly once.`;

/**
 * Reviews application questions already written, for the errors a scenario
 * invites and a single pass cannot reliably catch in itself: an answer that
 * leans on a rule the deck never taught, a program traced wrongly, and a
 * wrong option the scenario makes defensible. Flagged questions are dropped
 * and their cards retried, exactly as the vignette audit's are.
 */
export const APPLICATION_AUDIT_SYSTEM_PROMPT = `You are given application questions — a scenario, sometimes a short program, and a multiple-choice question — each with the flashcard it was written from, plus related cards from the same deck in "context". The related cards include every other card from the same batch, whether or not it has a question here. Check every question:

1. GROUNDED — the correct answer can be reached from the scenario using only the question's card and the related cards. Fail it if answering needs a rule, mechanism or fact they do not contain, or if the scenario asserts such a fact as background.
2. CORRECT — the marked correct answer really is right for this scenario. If there is a program, trace it line by line; the answer must match what it actually does.
3. ONE RIGHT ANSWER — check every wrong option against the question's own card AND every related card. Fail it if any card makes a wrong option also true for this scenario, or makes the marked answer only part of what happens — for example, the answer names one step and a related card says another step follows it.
4. SELF-CONTAINED — the scenario gives everything needed to answer and does not name the answer.
5. APPLIED — the question cannot be answered from the stem alone; it depends on something the scenario supplies. Fail a scenario that only narrates the card's own fact, followed by a stem that asks for that fact back. A question whose answer is the name of a tool, feature, API or term fails APPLIED even when it has a scenario: the scenario only decorates it.
6. NEW — compare structure, not names: list the parts of the card's example (and of the well-known example of the idea) and what drives each. Fail the question if its scenario has the same parts in the same roles with the same trigger, however they are named.

Return ONLY a JSON array, with no markdown fence and no commentary. Each element:
{"id": string, "ok": boolean, "failed": [string]}

"ok" is false if any check fails, true otherwise. "failed" lists the names of the checks that failed — GROUNDED, CORRECT, ONE RIGHT ANSWER, SELF-CONTAINED, APPLIED, NEW — and is empty when "ok" is true. Every id you were given must appear exactly once.`;

export interface LlmQuizQuestion {
  /** The batch-local id the model was given; mapped back to a real card by the caller. */
  id: string;
  stem: string;
  correct: string;
  distractors: string[];
  explanation: string;
  /**
   * The scenario. Empty for a recall question, and for a vignette that took
   * the escape hatch. An application question reads it from "scenario".
   */
  vignette?: string;
  /** A new program an application question is about. Never set for other styles. */
  code?: { language?: string; text: string };
}

/**
 * How many wrong answers a usable question carries, per style.
 *
 * A recall question offers four options and a board-style item five, which is
 * the only structural difference between them — everything downstream reads
 * `options.length` and does not care.
 */
const DISTRACTOR_COUNT = 3;
const VIGNETTE_DISTRACTOR_COUNT = 4;

/**
 * "All/none of the above" is a fixed idiom, not a judgement call, so it is
 * caught here rather than left to the prompt alone: a plain string match
 * cannot be overlooked the way an instruction can. A banned CORRECT answer
 * breaks the question outright (there is no single fact being tested) and is
 * rejected below; a banned DISTRACTOR is simply filtered out like a
 * duplicate, which still keeps the question if enough good ones remain.
 */
const BANNED_OPTIONS = new Set(['all of the above', 'none of the above'].map(normalizeOption));

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Turns one parsed object into a question, or null when it is not usable.
 *
 * The checks here are the last thing standing between a malformed response and
 * a test that marks someone wrong unfairly, so they are deliberately strict:
 * a question missing a field, or carrying two options that mean the same
 * thing, is dropped rather than repaired. The card it came from is then simply
 * one of the cards without a question, and gets offered again next time.
 */
function toQuestion(raw: unknown, distractorCount: number): LlmQuizQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;

  const id = trimmedString(item.id);
  const stem = trimmedString(item.stem);
  const correct = trimmedString(item.correct);
  const explanation = trimmedString(item.explanation);
  if (!id || !stem || !correct || !explanation) return null;
  if (BANNED_OPTIONS.has(normalizeOption(correct))) return null;

  // Absent or empty is legitimate: a recall question never has one, and a
  // board-style item whose card could not carry a scenario deliberately
  // returns "" rather than inventing a patient.
  const vignette = trimmedString(item.vignette);

  if (!Array.isArray(item.distractors)) return null;

  const seen = new Set([normalizeOption(correct)]);
  const distractors: string[] = [];
  for (const entry of item.distractors) {
    const text = trimmedString(entry);
    if (!text) continue;
    const key = normalizeOption(text);
    // A distractor that restates the correct answer, or another distractor,
    // leaves the question with two right answers or two identical options.
    // "All/none of the above" is dropped the same way, not treated as fatal
    // on its own — see BANNED_OPTIONS above.
    if (!key || seen.has(key) || BANNED_OPTIONS.has(key)) continue;
    seen.add(key);
    distractors.push(text);
  }

  // Too few is still fatal: padding a short question would mean inventing an
  // option here, with no idea whether it is wrong. Too many is not — a model
  // that offers four good wrong answers has done the hard part, so the extras
  // are dropped rather than the whole question.
  if (distractors.length < distractorCount) return null;

  return {
    id,
    stem,
    correct,
    distractors: distractors.slice(0, distractorCount),
    explanation,
    vignette: vignette || undefined,
  };
}

/** Parses a model response into questions, tolerating a fence or a cut-off reply. */
function parseResponse(text: string, distractorCount: number): LlmQuizQuestion[] {
  const parsed = parseJsonArray(text);
  const questions: LlmQuizQuestion[] = [];
  const usedIds = new Set<string>();
  for (const raw of parsed) {
    const question = toQuestion(raw, distractorCount);
    // One question per card: a model that answers twice for the same id would
    // otherwise put the same card in a test twice.
    if (!question || usedIds.has(question.id)) continue;
    usedIds.add(question.id);
    questions.push(question);
  }

  return questions;
}

/**
 * Limits on a program an application question writes. The prompt asks for
 * under 15 lines; these are the hard edge past which a snippet is no longer a
 * question-sized program and the whole question is dropped — it may be about
 * that code, so it cannot be kept without it.
 */
const MAX_APPLICATION_CODE_LINES = 25;
const MAX_APPLICATION_CODE_CHARS = 1500;

/** A usable program from a reply, null when there is none, or 'invalid'. */
function toCode(raw: unknown): { language?: string; text: string } | null | 'invalid' {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') return 'invalid';
  const item = raw as Record<string, unknown>;
  // Not trimmed at the start: leading indentation is part of a program.
  const text = typeof item.text === 'string' ? item.text.replace(/\s+$/, '') : '';
  if (!text.trim()) return 'invalid';
  if (text.length > MAX_APPLICATION_CODE_CHARS) return 'invalid';
  if (text.split('\n').length > MAX_APPLICATION_CODE_LINES) return 'invalid';
  const language = trimmedString(item.language);
  return language ? { language, text } : { text };
}

/** What an application reply holds: questions, and the cards the model declined. */
export interface ApplicationReply {
  questions: LlmQuizQuestion[];
  /** Cards judged to have nothing to apply, by batch-local id, with the model's reason. */
  skipped: { id: string; reason: string }[];
}

/**
 * Parses an application-style reply: four options, a scenario or a program,
 * and skips.
 *
 * A skip is an element carrying a non-empty "skip" string and no stem. It is a
 * verdict about the card, not a failure, so it is returned apart from the
 * questions and its card is not retried. An element that is neither a usable
 * question nor a skip is dropped, and its card is retried like any other.
 *
 * Stricter than the recall parser in two ways. A question with neither a
 * scenario nor a program is recall in disguise and is dropped. And a program
 * that is malformed or oversized drops its question rather than just itself,
 * because the stem is very likely about it.
 */
export function parseApplicationResponse(text: string): ApplicationReply {
  const questions: LlmQuizQuestion[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const usedIds = new Set<string>();

  for (const raw of parseJsonArray(text)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const id = trimmedString(item.id);
    if (!id || usedIds.has(id)) continue;

    const reason = trimmedString(item.skip);
    if (reason && !trimmedString(item.stem)) {
      usedIds.add(id);
      skipped.push({ id, reason });
      continue;
    }

    const code = toCode(item.code);
    if (code === 'invalid') continue;
    const question = toQuestion({ ...item, vignette: item.scenario }, DISTRACTOR_COUNT);
    if (!question) continue;
    if (!question.vignette && !code) continue;

    usedIds.add(id);
    questions.push(code ? { ...question, code } : question);
  }

  return { questions, skipped };
}

/** Parses a recall-style reply: four options, no vignette. */
export function parseQuizResponse(text: string): LlmQuizQuestion[] {
  return parseResponse(text, DISTRACTOR_COUNT);
}

/**
 * Parses a board-style reply: five options, usually with a vignette.
 *
 * The salvage pass inside matters more here than anywhere else in the app. A
 * vignette runs to four sentences before its five options, so a batch sits far
 * closer to the token ceiling than a recall batch does, and a truncated reply
 * is a routine outcome rather than a theoretical one.
 */
export function parseVignetteResponse(text: string): LlmQuizQuestion[] {
  return parseResponse(text, VIGNETTE_DISTRACTOR_COUNT);
}

/**
 * Reviews vignette questions already written, for the one thing a single
 * generation pass cannot reliably judge about its own output: whether a fact
 * it just invented is actually true, or whether a wrong answer it just wrote
 * is actually also right. Dropping a flagged question costs nothing a
 * malformed one wouldn't already cost — the card is simply offered again on
 * the retry pass, per the same philosophy as toQuestion() above.
 */
export const VIGNETTE_AUDIT_SYSTEM_PROMPT = `You are given clinical vignette questions and the flashcard(s) each was written from, plus the deck's context cards. For each question, check:

1. GROUNDING — does every finding stated in the vignette trace to the given card or the context cards? No invented vital signs, lab values, imaging findings, physical exam findings, history, medications, or numeric thresholds.
2. DISTRACTOR SAFETY — is any wrong option a diagnosis, finding, or next step that a real patient with this vignette's presentation could also plausibly have, even though it isn't what the card teaches?

A direct question with no vignette (the escape hatch) only needs check 2.

Return ONLY a JSON array, with no markdown fence and no commentary. Each element:
{"id": string, "ok": boolean}

"ok" is false if either check fails, true otherwise. Every id you were given must appear exactly once.`;

/**
 * The audit's verdict per question id, or nothing when the id never appears
 * in the reply. Missing is treated as failing by the caller, not passing —
 * the audit exists to catch a confidently wrong question, so a reply that
 * failed to cover an id is not evidence the id is fine.
 */
export function parseAuditResponse(text: string): Map<string, boolean> {
  const verdicts = new Map<string, boolean>();
  for (const raw of parseJsonArray(text)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const id = trimmedString(item.id);
    if (!id) continue;
    verdicts.set(id, item.ok === true);
  }
  return verdicts;
}

/**
 * Which checks the application audit named as failing, per question id.
 *
 * Read only to report a run: "NEW 2, APPLIED 1" says which rule is not
 * landing, where a bare reject count cannot distinguish a prompt that is too
 * strict from one rule that is being ignored. Deliberately separate from
 * parseAuditResponse, so the verdict never depends on this field — a reply
 * that omits "failed", or fills it with names that match no check, still
 * passes or fails on "ok" alone, exactly as it did before the field existed.
 */
export function parseAuditFailures(text: string): Map<string, string[]> {
  const failures = new Map<string, string[]>();
  for (const raw of parseJsonArray(text)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const id = trimmedString(item.id);
    if (!id) continue;
    const names = Array.isArray(item.failed)
      ? item.failed.map(trimmedString).filter((name) => name !== '')
      : [];
    failures.set(id, names);
  }
  return failures;
}
