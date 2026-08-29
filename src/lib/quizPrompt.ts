import { normalizeSlug as normalizeOption, stripJsonFence } from './textUtils';

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

Building the wrong answers:

- You are given a "neighbours" list: answers from other cards in the same deck. PREFER these. The best distractor is a near miss the deck itself contains — the adjacent stage in a sequence, a sibling term, the next row of the same table — because it tests whether the student can tell two real things apart.
- Write your own only when the neighbours offer nothing plausible for this stem. When you do, stay inside the deck's subject matter and keep to rule 4: it must be clearly wrong, not merely unmentioned.
- Never reuse the correct answer, in any wording, as one of the wrong answers.

Other rules:

- "explanation" is EXACTLY ONE SENTENCE saying why the correct answer is right. It is shown only to a student who got the question wrong, so make it teach the distinction. Do not write "as the card says" or refer to the card at all.
- Preserve exact numbers, percentages and technical identifiers verbatim in both the stem and the options. Do not round or paraphrase them.
- Some cards carry a code snippet, given as "questionCode". The student sees that snippet next to the question, so you may ask what it prints or what it does. Never retype the snippet into the stem or into an option.
- When a card's honest answer is itself a block of code, do not make four snippets the options. Ask what that code DOES or what it prints, and write four short prose options instead.
- When a card's back is vague, or is a long list, do not skip it. Narrow the stem to ONE specific, checkable fact drawn from that answer and ask about that fact alone.

Return ONLY a JSON array, with no markdown fence and no commentary. Each element:
{"id": string, "stem": string, "correct": string, "distractors": [string, string, string], "explanation": string}

"id" must be copied exactly from the card you used. Every card you were given must appear exactly once in the array.`;

export interface LlmQuizQuestion {
  /** The batch-local id the model was given; mapped back to a real card by the caller. */
  id: string;
  stem: string;
  correct: string;
  distractors: string[];
  explanation: string;
}

/** How many wrong answers a usable question carries. */
export const DISTRACTOR_COUNT = 3;


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
function toQuestion(raw: unknown): LlmQuizQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;

  const id = trimmedString(item.id);
  const stem = trimmedString(item.stem);
  const correct = trimmedString(item.correct);
  const explanation = trimmedString(item.explanation);
  if (!id || !stem || !correct || !explanation) return null;

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
  if (distractors.length < DISTRACTOR_COUNT) return null;

  return { id, stem, correct, distractors: distractors.slice(0, DISTRACTOR_COUNT), explanation };
}

/**
 * Pulls the complete objects out of a response whose array never closed.
 *
 * A quiz batch sits far closer to the token ceiling than a card batch does —
 * five strings per question rather than two — so a truncated reply is a real
 * outcome rather than a theoretical one. Parsing the array as a whole turns
 * that into the loss of every question in the batch, when all but the last are
 * intact. Scanning for balanced braces recovers them.
 *
 * String contents are tracked so a brace inside an option cannot end an object
 * early.
 */
function salvageObjects(text: string): unknown[] {
  const found: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          found.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // A malformed object among well-formed ones; the rest still stand.
        }
        start = -1;
      }
    }
  }

  return found;
}

/** Parses a model response into questions, tolerating a fence or a cut-off reply. */
export function parseQuizResponse(text: string): LlmQuizQuestion[] {
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
    const question = toQuestion(raw);
    // One question per card: a model that answers twice for the same id would
    // otherwise put the same card in a test twice.
    if (!question || usedIds.has(question.id)) continue;
    usedIds.add(question.id);
    questions.push(question);
  }

  return questions;
}
