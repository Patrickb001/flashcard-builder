import type { Block, CodeBlock, DocumentSection, ImageBlock, TableBlock } from './documentModel';
import type { CandidateCard, CardCode, CardImage } from '../types';
import { dedupeCards, isUsableCard, isMeaningfulLabel } from './cardValidation';
import {
  codeQuestion,
  diagramQuestion,
  headingQuestion,
  labelQuestion,
  listQuestion,
  outputQuestion,
  reverseTableQuestion,
  softenAllCaps,
  splitHeadingAge,
  tableQuestion,
  termQuestion,
} from './phrasing';

/**
 * Generates flashcards from structured blocks.
 *
 * Each block type has its own rule, and question wording is delegated to the
 * phrasing module so fronts read as real questions rather than as parsed text
 * with a question mark appended.
 */

const MAX_CARDS_PER_SECTION = 30;

function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[;,]$/, '');
}

/** "Term: definition" inside a single line. */
function splitTermDefinition(line: string): { term: string; def: string } | null {
  const m = tidy(line).match(/^([A-Za-z0-9][^:]{2,60}?):\s+(.{8,})$/);
  if (!m) return null;
  const term = m[1].trim();
  const def = m[2].trim();
  if (term.split(/\s+/).length > 9) return null;
  // A discourse marker ("For example:", "Note:") is not a term worth learning.
  if (!isMeaningfulLabel(term)) return null;
  return { term, def };
}

// ---------------------------------------------------------------------------
// Prose mode: mining definitions from running text
// ---------------------------------------------------------------------------

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z“"'(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const PRONOUN_SUBJECTS =
  /^(it|this|that|these|those|there|they|we|you|he|she|i|one|some|most|many|both|all|each|another|others?)\b/i;

/** A clause opener is never the subject being defined. */
const CONJUNCTION_START =
  /^(but|and|or|so|yet|because|although|though|while|if|when|whereas|since|unless|until|after|before)\b/i;

/**
 * Extracts definitional statements from prose. Article-style PDFs carry their
 * value in sentences like "a type is the concept of ...", which the block rules
 * alone would never surface.
 */
function definitionsFromProse(text: string): { term: string; def: string }[] {
  const found: { term: string; def: string }[] = [];

  for (const raw of splitSentences(text)) {
    // Drop a short introductory clause ("Seen in this way, ...") so the real
    // subject of the sentence is at the front where the patterns can see it.
    const sentence = raw.replace(/^[A-Z][^,]{0,40},\s+(?=[a-z])/, '');
    if (sentence.split(/\s+/).length > 42) continue;

    const patterns: RegExp[] = [
      /^(?:(?:a|an|the)\s+)?([A-Za-z][\w\s./'-]{2,45}?)\s+is\s+the\s+concept\s+of\s+(.{10,})$/i,
      /^(?:(?:a|an|the)\s+)?([A-Za-z][\w\s./'-]{2,45}?)\s+(?:is|are)\s+(?:defined\s+as|referred\s+to\s+as|known\s+as|called)\s+(.{8,})$/i,
      /^(?:(?:a|an|the)\s+)?([A-Za-z][\w\s./'-]{2,45}?)\s+(?:refers\s+to|means)\s+(.{8,})$/i,
      /^(?:(?:a|an|the)\s+)?([A-Za-z][\w\s./'-]{2,45}?)\s+(?:is|are)\s+(a|an|the)\s+(.{8,})$/i,
    ];

    for (const re of patterns) {
      const m = sentence.match(re);
      if (!m) continue;
      const term = m[1].trim();
      const def = (m.length > 3 ? `${m[2]} ${m[3]}` : m[2]).trim().replace(/[.]$/, '');
      if (PRONOUN_SUBJECTS.test(term) || CONJUNCTION_START.test(term)) break;
      if (term.split(/\s+/).length > 7) break;
      if (!isMeaningfulLabel(term)) break;
      found.push({ term, def });
      break;
    }

    // "... is sometimes called downleveling." — the term is at the end.
    const trailing = sentence.match(
      /^(.{15,}?)\s+is\s+(?:sometimes\s+)?(?:called|known\s+as|termed)\s+([A-Za-z][\w-]{2,30})[.]?$/i
    );
    if (trailing) {
      const term = trailing[2].trim();
      const def = trailing[1].trim();
      if (isMeaningfulLabel(term) && def.split(/\s+/).length <= 40) {
        found.push({ term, def });
      }
    }
  }

  return found;
}

/**
 * Article-style documents put their value in sections whose paragraphs are far
 * too long to be answers. When a section yields nothing else, this finds the
 * sentence that actually explains the section's own title and uses that.
 */
function sectionSummaryCard(section: DocumentSection): CandidateCard | null {
  const title = section.title?.trim();
  if (!title) return null;
  if (!isMeaningfulLabel(title)) return null;
  // A title with its own internal punctuation is a slide headline, not a term.
  if (/[:;]/.test(title)) return null;

  // Distinctive words from the title, ignoring filler.
  const keywords = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !/^(with|from|this|that|page|the|and|for|your)$/.test(w));
  if (keywords.length === 0) return null;

  let best: { sentence: string; score: number } | null = null;

  for (const block of section.blocks) {
    if (block.kind !== 'paragraph') continue;
    for (const sentence of splitSentences(tidy(block.text))) {
      const words = sentence.split(/\s+/).length;
      if (words < 8 || words > 45) continue;
      // A sentence opening with a conjunction depends on the one before it and
      // will not stand alone as an answer.
      if (CONJUNCTION_START.test(sentence)) continue;
      const lower = sentence.toLowerCase();
      const hits = keywords.filter((k) => lower.includes(k)).length;
      if (hits === 0) continue;
      // Prefer sentences that both mention the topic and read like a statement
      // about it, and prefer earlier, shorter ones.
      const score =
        hits * 10 +
        (/\b(is|are|describes?|means|lets?|allows?|makes?)\b/.test(lower) ? 5 : 0) -
        (PRONOUN_SUBJECTS.test(sentence) ? 6 : 0) -
        words / 10;
      if (!best || score > best.score) best = { sentence, score };
    }
  }

  if (!best) return null;

  return {
    front: termQuestion(title),
    back: best.sentence.replace(/^[A-Z][^,]{0,40},\s+(?=[a-z])/, ''),
    sourceLabel: section.label,
    context: title,
    include: true,
  };
}

// ---------------------------------------------------------------------------
// Table cards
// ---------------------------------------------------------------------------

function cardsFromTable(table: TableBlock, label: string, context?: string): CandidateCard[] {
  const cards: CandidateCard[] = [];
  const [rowHeader, ...colHeaders] = table.headers;
  const scope = table.context ?? context;

  for (const row of table.rows) {
    const [rowKey, ...cells] = row;
    if (!rowKey) continue;

    cells.forEach((cell, i) => {
      const colHeader = colHeaders[i];
      if (!cell || !colHeader) return;
      cards.push({
        front: tableQuestion({ rowHeader, rowKey, colHeader, context: scope }),
        back: tidy(cell),
        sourceLabel: label,
        context: scope,
        include: true,
      });
    });

    // One reverse card per row, so the row label itself gets recalled.
    if (cells[0] && tidy(cells[0]).length > 12) {
      cards.push({
        front: reverseTableQuestion(rowHeader, tidy(cells[0])),
        back: tidy(rowKey),
        sourceLabel: label,
        context: scope,
        include: true,
      });
    }
  }

  return cards;
}

// ---------------------------------------------------------------------------
// Snippets and diagrams
// ---------------------------------------------------------------------------

/** The optional parts of a card, so `push` can carry them without new callers. */
type CardMedia = Pick<CandidateCard, 'frontCode' | 'backCode' | 'image'>;

/** Longer than this and a paragraph is a passage, not an answer. */
const MAX_PROSE_WORDS = 45;

/**
 * Cards for one snippet.
 *
 * Two different things are worth learning from a program, so it can yield two
 * cards: what it prints, which is a reading exercise with the code on the
 * front; and how it is written, which is a recall exercise with the code on the
 * back. The second needs a sentence to answer with, and only the page can
 * supply that — inventing one is what the drafting model is for.
 */
function cardsFromCode(
  block: CodeBlock,
  label: string,
  context: string | undefined,
  pendingHeading: string | null,
  prose: string | null
): CandidateCard[] {
  const cards: CandidateCard[] = [];
  const topic = block.heading ?? pendingHeading ?? context;
  const code: CardCode = { text: block.text, language: block.language };

  if (block.output) {
    cards.push({
      front: outputQuestion(topic, block.language),
      back: block.output,
      sourceLabel: label,
      context,
      frontCode: code,
      include: true,
    });
  }

  if (topic && isMeaningfulLabel(topic) && prose) {
    cards.push({
      front: codeQuestion(topic, block.language),
      back: prose,
      sourceLabel: label,
      context,
      backCode: code,
      include: true,
    });
  }

  return cards;
}

/**
 * A card for one diagram.
 *
 * The picture is the answer, but a card still needs words on its back: a
 * diagram alone cannot be checked against what the student recalled. The
 * sentence that introduced it does that job, so a diagram with no prose around
 * it is left out rather than turned into a card that answers nothing.
 */
function cardFromImage(
  block: ImageBlock,
  label: string,
  context: string | undefined,
  pendingHeading: string | null,
  prose: string | null
): CandidateCard | null {
  const topic = block.heading ?? pendingHeading ?? context;
  if (!topic || !isMeaningfulLabel(topic)) return null;

  const back = block.caption ?? prose;
  if (!back) return null;

  const image: CardImage = { src: block.src, alt: block.alt };
  return {
    front: diagramQuestion(topic),
    back,
    sourceLabel: label,
    context,
    image,
    include: true,
  };
}

// ---------------------------------------------------------------------------
// Section walk
// ---------------------------------------------------------------------------

export function cardsFromSection(section: DocumentSection): CandidateCard[] {
  const cards: CandidateCard[] = [];
  const blocks = section.blocks;
  const ctx = section.title;

  const hasStructure = blocks.some(
    (b) => b.kind === 'table' || b.kind === 'list' || b.kind === 'code' || b.kind === 'image'
  );
  if (!section.title && !hasStructure) return [];

  let pendingHeading: string | null = null;
  let pendingChip: string | null = null;

  const push = (front: string, back: string, media: CardMedia = {}) => {
    cards.push({ front, back, sourceLabel: section.label, context: ctx, include: true, ...media });
  };

  /**
   * The last paragraph seen, kept as the answer text for the snippet or diagram
   * that follows it.
   *
   * A snippet is not an answer on its own: "how is a for-each loop written?"
   * needs a sentence saying what it does, with the code beside it. The sentence
   * introducing the snippet is exactly that, and on a tutorial page it is
   * always the paragraph directly above.
   */
  let lastProse: string | null = null;

  for (const block of blocks as Block[]) {
    if (block.kind === 'heading') {
      if (block.level === 1) {
        pendingHeading = null;
        pendingChip = null;
      } else if (isMeaningfulLabel(block.text)) {
        pendingHeading = block.text;
      }
      continue;
    }

    if (block.kind === 'table') {
      cards.push(...cardsFromTable(block, section.label, ctx));
      pendingHeading = null;
      continue;
    }

    if (block.kind === 'paragraph') {
      const text = tidy(block.text);
      if (text.split(/\s+/).length <= MAX_PROSE_WORDS) lastProse = text;

      if (/^\s*\d/.test(text) && text.length <= 24 && /\d/.test(text) && !/[.!?]$/.test(text)) {
        // A short age or number chip labels the heading that follows it.
        pendingChip = text;
        continue;
      }

      if (block.heading && isMeaningfulLabel(block.heading)) {
        push(labelQuestion(block.heading), text);
        pendingHeading = null;
        continue;
      }

      if (pendingHeading) {
        push(headingQuestion(pendingHeading), text);
        if (pendingChip) {
          push(`${pendingHeading} — what age range?`, pendingChip);
          pendingChip = null;
        }
        pendingHeading = null;
        continue;
      }

      // Unlabelled prose: mine explicit term/definition constructions.
      const td = splitTermDefinition(text);
      if (td) {
        push(termQuestion(td.term), td.def);
        continue;
      }
      for (const def of definitionsFromProse(text)) {
        push(termQuestion(def.term), def.def);
      }
      continue;
    }

    if (block.kind === 'code') {
      cards.push(...cardsFromCode(block, section.label, ctx, pendingHeading, lastProse));
      pendingHeading = null;
      continue;
    }

    if (block.kind === 'image') {
      const card = cardFromImage(block, section.label, ctx, pendingHeading, lastProse);
      if (card) cards.push(card);
      pendingHeading = null;
      continue;
    }

    if (block.kind === 'list') {
      const heading = block.heading ?? pendingHeading ?? undefined;
      const items = block.items.map(tidy).filter(Boolean);
      if (items.length === 0) continue;

      const structured = items.map(splitTermDefinition);
      const structuredCount = structured.filter(Boolean).length;

      if (structuredCount >= Math.ceil(items.length / 2)) {
        structured.forEach((td, idx) => {
          if (td) push(termQuestion(td.term), td.def);
          else if (heading && isMeaningfulLabel(heading)) {
            push(`${heading} — which item?`, items[idx]);
          }
        });
      } else if (heading && isMeaningfulLabel(heading)) {
        // A heading that carries its own range ("SENSORIMOTOR (0-2 yr)") is two
        // separate facts, so it is split the same way an age chip would be.
        const split = splitHeadingAge(heading);
        const name = softenAllCaps(split ? split.name : heading);
        // A named stage reads as "What characterizes X?"; a plain set heading
        // ("Common features") reads as "What are the common features?".
        push(split ? headingQuestion(name) : listQuestion(name), items.map((it) => `• ${it}`).join('\n'));
        const age = split?.age ?? pendingChip;
        if (age) {
          push(`${name} — what age range?`, age);
          pendingChip = null;
        }
      }

      pendingHeading = null;
      continue;
    }
  }

  // Prose sections (no table, no list) rely on the summary fallback, since
  // their paragraphs are too long to serve as answers on their own.
  if (!hasStructure) {
    const summary = sectionSummaryCard(section);
    if (summary) cards.unshift(summary);
  }

  return cards.slice(0, MAX_CARDS_PER_SECTION);
}

export function generateCandidates(sections: DocumentSection[]): CandidateCard[] {
  const all: CandidateCard[] = [];
  for (const section of sections) {
    all.push(...cardsFromSection(section));
  }
  return dedupeCards(all.filter(isUsableCard));
}
