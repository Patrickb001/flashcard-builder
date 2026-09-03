import type { CandidateCard } from '../types';
import {
  contentWords,
  hasConflictingNumbers,
  normalizeSlug as normalize,
  wordOverlap,
} from './textUtils';

/**
 * Last line of defence before a card reaches the review screen. These rules
 * catch fragments, slide dumps, and — importantly for web-printed PDFs — the
 * navigation chrome and discourse markers that look structurally like content.
 */

const BOILERPLATE_FRONT =
  /^(what characterizes\s+)?(learning objectives?|objectives?|references?( & further reading)?|further reading|agenda|outline|overview|key takeaways?|takeaways?|questions?|thank you|acknowledg|disclosures?|class discussion|on this page|is this page helpful|search docs|popular documentation pages|using \w+|community|contributors to this page|site colours?|site colors?|code font|previous|next|customize|made with)/i;

/**
 * Words that introduce a thought rather than name a concept. A colon after any
 * of these is punctuation, not a definition, so "For example: typos, uncalled
 * functions" must not become a card.
 */
const DISCOURSE_MARKERS =
  /^(for example|for instance|e\.?g|i\.?e|note|notes|remember|tip|warning|caution|important|anyway|however|therefore|thus|so|and|but|or|also|in short|in summary|in other words|in this case|in contrast|for reference|see also|as follows|the following|example|examples|result|results|conclusion|summary|question|answer|hint|reminder|aside|caveat|disclaimer|update|edit|source|sources|via|from|to|by|with|about|explanation|explanations|working|output|code|program|definition)$/i;

/** Chrome that appears on printed web pages. */
const WEB_CHROME =
  /^(docs|community|tools|search|menu|home|blog|download|playground|get started|get help|sign in|log in|share|print|copy|yes|no|skip to|back to top|table of contents)$/i;

const MAX_BACK_WORDS = 60;
const MAX_FRONT_WORDS = 32;
const MIN_BACK_CHARS = 3;

/**
 * True when a label names a concept worth building a card around, rather than
 * being a discourse marker, a page control, or a whole sentence.
 */
export function isMeaningfulLabel(label: string): boolean {
  const l = label.trim().replace(/[:?.]+$/, '');
  if (l.length < 3 || l.length > 70) return false;

  if (DISCOURSE_MARKERS.test(l)) return false;
  if (WEB_CHROME.test(l)) return false;

  const words = l.split(/\s+/);
  if (words.length > 7) return false;

  // A label containing a personal pronoun is a sentence fragment, not a term:
  // "Anyway, we can quickly fix up the error".
  if (/\b(we|you|i|they|it|he|she|us|our|your|my|their)\b/i.test(l)) return false;

  // Commas inside a short label usually mean prose — but a parenthetical gloss
  // ("Limbic system (reward, emotion)") is legitimate, so it is stripped first.
  if (l.replace(/\([^)]*\)/g, '').includes(',')) return false;

  if (!/[A-Za-z]{3,}/.test(l)) return false;

  // Imperative lead-ins ("Notice two things here:") are instructions to the
  // reader, not concepts to memorize.
  if (/^(notice|note|see|consider|look|observe|recall|imagine|try|check|compare|suppose|assume|let|say)\b/i.test(l)) {
    return false;
  }

  // Deictic labels point at nearby content instead of naming something.
  if (/\b(here|below|above|following|previous|next)\b/i.test(l)) return false;

  // A finite verb makes this a clause, not a name. "JavaScript has three very
  // commonly used primitives" and "Functions are the primary" are sentences
  // that happened to sit before a colon.
  if (/\b(is|are|was|were|has|have|had|can|could|will|would|should|do|does|did|says?|means|allows?|makes?|takes?|gets?|comes?|goes)\b/i.test(l)) {
    return false;
  }

  return true;
}

/**
 * True when a drafted card is worth showing on the review screen.
 *
 * Fourteen sequential reject rules, in rough order of cost: empty or stunted
 * text, truncated fragments left by the extractor, cards too long to study,
 * boilerplate and page chrome, and finally a front that merely restates its
 * back. Each rule is annotated with the source material that motivated it.
 *
 * The bar is deliberately low — this is a last line of defence against obvious
 * junk, not a quality judgement. Deciding which of two reasonable cards is
 * better is the reviewer's job, not this function's.
 */
export function isUsableCard(card: CandidateCard): boolean {
  const front = card.front.trim();
  const back = card.back.trim();

  if (!front || !back) return false;
  if (back.length < MIN_BACK_CHARS) return false;

  // Truncated fragments: "…impulse control =". The operator has to be standing
  // on its own to count: a language name ends in one — "how is this written in
  // C++?" — and testing the character alone threw away every card about C++
  // and C# in a deck built from a programming tutorial.
  const stem = front.replace(/\.\.\.\?$/, '').replace(/\?$/, '');
  if (/[:;,/]$/.test(stem) || /(^|\s)[=+\-–—]$/.test(stem)) return false;
  if (/(^|\s)[=+]$/.test(back)) return false;

  if (front.split(/\s+/).length > MAX_FRONT_WORDS) return false;
  if (back.split(/\s+/).length > MAX_BACK_WORDS) return false;

  if (BOILERPLATE_FRONT.test(front)) return false;

  // Strip the generated wrapper before testing the underlying label, so
  // "What is important about note?" is rejected along with a bare "Note?".
  const core = front
    .replace(/^what (is|are) important about\s+/i, '')
    .replace(/^what characterizes\s+/i, '')
    .replace(/^what (is|are)\s+/i, '')
    .replace(/[?.]+$/, '')
    .trim();
  if (DISCOURSE_MARKERS.test(core) || WEB_CHROME.test(core)) return false;
  if (BOILERPLATE_FRONT.test(core)) return false;

  const frontCore = front.replace(/[?:.\s]+$/, '');
  if (/^[\d\s.)+-]+$/.test(frontCore)) return false;
  if (frontCore.length < 3) return false;

  if (normalize(front) === normalize(back)) return false;
  if (normalize(back).length < 4) return false;

  return true;
}

/**
 * How alike two cards must be to count as the same card.
 *
 * Both halves have to match: a deck legitimately asks several questions about
 * one idea, so a similar front alone is not duplication. The thresholds are
 * deliberately high, because a duplicate that survives is only a card seen
 * twice, while a distinct card wrongly dropped is material the student never
 * studies and cannot tell is missing.
 *
 * Lower values were tried and measured — see "Card de-duplication" in
 * docs/tuning-notes.md, which also records what this cannot catch.
 */
const DUPLICATE_FRONT = 0.9;
const DUPLICATE_BACK = 0.9;

/**
 * Too few words on either side to judge by overlap at all.
 *
 * The measure divides by the shorter text, which is what makes a terse card
 * comparable to a wordy one — and what makes a very short one match everything.
 * Below this on either the fronts or the backs no judgement is made and the
 * card is kept; exact repeats are still caught by the normalized key.
 */
const MIN_WORDS_TO_COMPARE = 4;

/**
 * A card with its words already extracted.
 *
 * Every candidate is compared against every card kept before it, so tokenizing
 * inside the comparison would re-derive one card's words hundreds of times over.
 * Extracted once here instead, on the way in.
 */
interface Weighed {
  card: CandidateCard;
  front: Set<string>;
  back: Set<string>;
}

const weigh = (card: CandidateCard): Weighed => ({
  card,
  front: contentWords(card.front),
  back: contentWords(card.back),
});

/** True when two cards ask the same question and give the same answer. */
function isNearDuplicate(a: Weighed, b: Weighed): boolean {
  // Checked before anything else: two cards quoting different figures are the
  // two sides of a contrast, and the more words they share the more certain
  // that is. Merging them would delete half of a distinction silently.
  if (hasConflictingNumbers(a.card.back, b.card.back)) return false;
  if (hasConflictingNumbers(a.card.front, b.card.front)) return false;

  // A page often states one idea three ways: as prose, as a snippet, and as a
  // diagram. Those cards share their text and differ only in what they carry,
  // so judging them on words alone throws away the snippet and keeps the prose.
  // Anything the candidate carries that the kept card does not makes it a
  // different card.
  if ((b.card.frontCode || b.card.backCode) && !(a.card.frontCode || a.card.backCode)) return false;
  if (b.card.image && !a.card.image) return false;

  if (Math.min(a.front.size, b.front.size) < MIN_WORDS_TO_COMPARE) return false;
  if (Math.min(a.back.size, b.back.size) < MIN_WORDS_TO_COMPARE) return false;

  return (
    wordOverlap(a.front, b.front) >= DUPLICATE_FRONT &&
    wordOverlap(a.back, b.back) >= DUPLICATE_BACK
  );
}

/**
 * Drops cards that repeat one another, exactly or near enough.
 *
 * A document that makes the same point twice — a summary slide restating a body
 * slide, a recap card beside the card it recaps — otherwise yields both, so the
 * reader sees one fact twice in study and the test writes two questions with the
 * same answer.
 *
 * The first card of a pair wins, so a deck keeps its document order and the
 * earlier, usually fuller statement of a fact.
 */
export function dedupeCards(cards: CandidateCard[]): CandidateCard[] {
  const seen = new Set<string>();
  const out: Weighed[] = [];

  for (const card of cards) {
    const key = normalize(card.front);
    if (seen.has(key)) continue;

    // O(n²) against what survived, not against the input, and comparing
    // pre-extracted word sets rather than re-reading text — see wordOverlap.
    const candidate = weigh(card);
    if (out.some((kept) => isNearDuplicate(kept, candidate))) continue;

    seen.add(key);
    out.push(candidate);
  }

  return out.map((kept) => kept.card);
}
