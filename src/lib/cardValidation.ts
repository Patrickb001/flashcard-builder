import type { CandidateCard } from '../types';
import { normalizeSlug as normalize } from './textUtils';

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

export function dedupeCards(cards: CandidateCard[]): CandidateCard[] {
  const seen = new Set<string>();
  const out: CandidateCard[] = [];
  for (const card of cards) {
    const key = normalize(card.front);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(card);
  }
  return out;
}
