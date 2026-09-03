import { normalizeSlug as normalizeOption, salvageObjects, stripJsonFence } from './textUtils';

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
 */

export const QUIZ_SYSTEM_PROMPT = `You write multiple-choice questions for a student revising from a deck of flashcards they have already studied. Each question is graded automatically, so it has to be exactly right.

You are given some cards from one deck. Write EXACTLY ONE question for EVERY card you are given. A card that comes back without a question is a card the student cannot revise, so a missing question is a failure, not a safe default.

Every question must satisfy ALL of these:

1. SELF-CONTAINED — the stem must make sense on its own. It may reword the card's front, but never write "which of the following", "according to the card", or refer to anything the student cannot see.
2. THE CORRECT ANSWER IS THE CARD'S BACK — condensed to a short phrase or a single line if the back is long. Never invent a different right answer, and never make the answer something the card does not say.
3. EXACTLY THREE WRONG ANSWERS. Not two, not four.
4. EVERY WRONG ANSWER MUST BE UNAMBIGUOUSLY WRONG for this stem. This is the rule that matters most. A distractor that is arguably also correct makes the question unanswerable and marks a student wrong for knowing the material. Where the deck itself offers nothing plausible, write the wrong answers from the subject matter instead — but they must still be clearly and defensibly wrong. This is the one rule you may never trade away for coverage.
5. NO LENGTH TELL — do not make the correct answer the longest, the most detailed, or the most carefully qualified option. A student must not be able to pick it out by shape alone. Keep all four options about the same length and the same kind of thing: if the answer is a number, the wrong ones are numbers; if it is a definition, they are definitions. Keep EVERY option under 15 words — a long option is itself a tell, and a shorter one is a cleaner test.
6. PLAUSIBLE, NOT ABSURD — a wrong answer should be something a student who half-learned the material might believe. Joke options and obvious nonsense teach nothing.

Using the neighbouring cards:

You are given a "neighbours" list: other cards from the same deck, each as {"front": the question it asks, "back": its answer}. They are there for two things.

1. WRONG ANSWERS. PREFER a neighbour's answer. The best distractor is a near miss the deck itself contains — the adjacent stage in a sequence, a sibling term, the next row of the same table — because it tests whether the student can tell two real things apart. Write your own only when the neighbours offer nothing plausible, and when you do, stay inside the deck's subject matter and keep to rule 4: clearly wrong, not merely unmentioned. Never reuse the correct answer, in any wording, as a wrong answer.

2. CHECKING THAT A WRONG ANSWER IS WRONG. This is why each neighbour comes with the question it answers. Before using a neighbour's answer as a wrong answer, read its front. If that question is asking the same thing as the question you are writing, then its answer is ALSO CORRECT for your question — using it would mark a student wrong for knowing the material. Skip it and choose another. Decks often state the same fact twice in different words, and a bare answer gives you no way to notice.

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

OTHER RULES:

- "explanation" is EXACTLY ONE SENTENCE saying why the correct answer is right. It is shown only to a student who got the question wrong, so make it teach the distinction. Do not refer to "the card".
- Preserve exact numbers, percentages and identifiers verbatim.
- Some cards carry a code snippet as "questionCode". Ignore it for vignette purposes; it is not clinical material.

Return ONLY a JSON array, with no markdown fence and no commentary. Each element:
{"id": string, "vignette": string, "stem": string, "correct": string, "distractors": [string, string, string, string], "explanation": string}

"id" must be copied exactly from the card you used. Every card you were given must appear exactly once in the array. "vignette" is the empty string when the escape hatch applies.`;

export interface LlmQuizQuestion {
  /** The batch-local id the model was given; mapped back to a real card by the caller. */
  id: string;
  stem: string;
  correct: string;
  distractors: string[];
  explanation: string;
  /** Empty for a recall question, and for a vignette that took the escape hatch. */
  vignette?: string;
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
    if (!key || seen.has(key)) continue;
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
  const cleaned = stripJsonFence(text);

  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');

  let parsed: unknown[] | null = null;
  if (start !== -1 && end > start) {
    try {
      const asArray = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(asArray)) parsed = asArray;
    } catch {
      // Falls through to the salvage pass below.
    }
  }

  if (!parsed) parsed = salvageObjects(cleaned);

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
