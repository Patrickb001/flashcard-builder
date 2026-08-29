/**
 * Turns raw labels into questions that actually read like questions.
 *
 * The previous version appended "?" to whatever text it had parsed, producing
 * fronts like "2 mo — Social/Cognitive?". Phrasing is now chosen from the shape
 * of the label: what kind of thing the row is, whether the column header is
 * plural, and what the surrounding section is about.
 */

const PREPOSITION_ENDINGS =
  /\b(by|of|for|with|in|to|from|on|at|as|into|about|between|through)$/i;

/** Column headers that are inherently plural even without a trailing "s". */
const PLURAL_HINTS = /\b(implications?|features?|milestones?|findings?|criteria|behaviou?rs?|points?|categories)\b/i;

function isPlural(label: string): boolean {
  const clean = label.trim();
  if (PLURAL_HINTS.test(clean)) return /s\b/i.test(clean) || /criteria/i.test(clean);
  return /[^s]s$/i.test(clean);
}

function be(label: string): string {
  return isPlural(label) ? 'are' : 'is';
}

/** "Avoidant (~20%)" -> "Avoidant". The statistic belongs on the answer side. */
function stripParenthetical(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, '').trim() || label.trim();
}

function lower(label: string): string {
  // Leaves acronyms and code identifiers alone.
  return /^[A-Z0-9/\s.-]+$/.test(label) && label.length <= 6 ? label : label.toLowerCase();
}

function singular(noun: string): string {
  const n = noun.trim().toLowerCase();
  if (n.endsWith('ies')) return `${n.slice(0, -3)}y`;
  if (n.endsWith('ses')) return n.slice(0, -2);
  if (n.endsWith('s') && !n.endsWith('ss')) return n.slice(0, -1);
  return n;
}

const AGE_VALUE_RE = /^\s*\d+\s*(?:[–—-]\s*\d+\s*)?(?:mo|yr|months?|years?|weeks?|days?)\b|^\s*\d+\s*\+/i;

function looksLikeAge(value: string): boolean {
  return AGE_VALUE_RE.test(value.trim());
}

/** Row headers that name a dimension being compared across states. */
const DIMENSION_HEADERS = /^(domain|area|aspect|category|dimension|feature|characteristic)s?$/i;

/**
 * Picks a noun for the thing a table row represents, preferring the section
 * title when the row header would just repeat the column header.
 */
function subjectNoun(rowHeader: string | undefined, context: string | undefined): string | null {
  if (rowHeader && rowHeader.trim()) return singular(rowHeader);
  if (context) {
    const first = context.trim().split(/\s+/)[0];
    if (first && first.length > 3) return first.toLowerCase();
  }
  return null;
}

/** A plural noun from the section title, e.g. "milestones" from the slide name. */
function domainNoun(context: string | undefined): string | null {
  if (!context) return null;
  const words = context.toLowerCase().split(/\s+/);
  const known = words.find((w) => /^(milestones?|findings?|criteria|features?|red flags?)$/.test(w));
  return known ? (known.endsWith('s') ? known : `${known}s`) : null;
}

export interface TableQuestionInput {
  rowHeader?: string;
  rowKey: string;
  colHeader: string;
  context?: string;
}

export function tableQuestion({ rowHeader, rowKey, colHeader, context }: TableQuestionInput): string {
  const row = stripParenthetical(rowKey);
  const col = lower(colHeader.trim());
  const verb = be(colHeader);

  // Age-indexed rows read best as "At 2 mo, what are the motor milestones?"
  if (looksLikeAge(row) || (rowHeader && /^age/i.test(rowHeader.trim()))) {
    const noun = domainNoun(context);
    // When a domain noun is appended it becomes the head of the noun phrase, so
    // the verb must agree with it rather than with the column header.
    return noun
      ? `At ${row}, what ${be(noun)} the ${col} ${noun}?`
      : `At ${row}, what ${verb} the ${col}?`;
  }

  // Rows that name a dimension compared across states: "In normal aging, what
  // is expected for memory?"
  if (rowHeader && DIMENSION_HEADERS.test(rowHeader.trim())) {
    return `In ${col}, what ${be(rowKey)} expected for ${lower(row)}?`;
  }

  const noun = subjectNoun(rowHeader, context);

  // When the column header already contains the row's noun ("Caregiver Pattern"
  // for a "Pattern" row), "of the X pattern" would stutter. Fall back to a noun
  // taken from the section title, or drop the noun entirely.
  if (noun && col.includes(noun)) {
    const scope = context ? singular(context.trim().split(/\s+/)[0]) : null;
    return scope && scope !== noun && scope.length > 3
      ? `What ${verb} the ${col} in ${row} ${scope}?`
      : `What ${verb} the ${col} for ${row}?`;
  }

  return noun
    ? `What ${verb} the ${col} of the ${row} ${noun}?`
    : `What ${verb} the ${col} of ${row}?`;
}

export function reverseTableQuestion(
  rowHeader: string | undefined,
  cellValue: string
): string {
  const noun = rowHeader ? singular(rowHeader) : null;
  if (!noun) return `What is characterized by: ${cellValue}?`;
  if (/^age/.test(noun)) return `Which age is associated with: ${cellValue}?`;
  return `Which ${noun} is characterized by: ${cellValue}?`;
}

/** Question for a section heading that introduces explanatory prose. */
export function headingQuestion(heading: string): string {
  const h = stripOrdinal(heading).replace(/[:?]+$/, '');
  if (/^(what|which|who|when|where|why|how)\b/i.test(h)) return `${h}?`;
  if (PREPOSITION_ENDINGS.test(h)) return `${h}...?`;
  return `What characterizes ${h}?`;
}

/** Question for an inline label such as "Substance use vulnerability:". */
export function labelQuestion(label: string): string {
  const l = stripOrdinal(label).replace(/[:?]+$/, '');
  if (/^(what|which|who|when|where|why|how)\b/i.test(l)) return `${l}?`;
  if (PREPOSITION_ENDINGS.test(l)) return `${l}...?`;
  // Casing is preserved: acronyms and proper nouns must not be flattened.
  return `What is important about ${l}?`;
}

/**
 * Splits a heading that carries its own age range, e.g. "SENSORIMOTOR (0-2 yr)".
 * The stage name and its range are different facts and recall better as two
 * cards, matching how age-chipped headings are already handled elsewhere.
 */
export function splitHeadingAge(heading: string): { name: string; age: string } | null {
  const m = heading.trim().match(/^(.{2,60}?)\s*\(([^)]*\d[^)]*)\)\s*$/);
  if (!m) return null;
  const name = m[1].trim();
  const age = m[2].trim();
  if (!looksLikeAge(age) && !/\d/.test(age)) return null;
  // Only a genuine age/duration range, not a statistic like "~20%".
  if (!/\b(mo|yr|months?|years?|weeks?|days?)\b/i.test(age)) return null;
  return { name, age };
}

/** "SENSORIMOTOR" -> "Sensorimotor"; leaves mixed-case names alone. */
export function softenAllCaps(text: string): string {
  if (!/[a-z]/.test(text) && /[A-Z]{3,}/.test(text)) {
    return text
      .toLowerCase()
      .replace(/(^|[\s(/-])([a-z])/g, (_, p, c) => p + c.toUpperCase());
  }
  return text;
}

/** Question for a bulleted set introduced by a heading. */
export function listQuestion(heading: string): string {
  const h = stripOrdinal(heading).replace(/[:?]+$/, '');
  if (/^(what|which|who|when|where|why|how)\b/i.test(h)) return `${h}?`;
  if (PREPOSITION_ENDINGS.test(h)) return `${h}...?`;
  return `What ${be(h)} the ${lower(h)}?`;
}

/** Question for a term found in a "Term: definition" construction. */
export function termQuestion(term: string): string {
  const t = term.trim();
  if (/^(what|which|who|when|where|why|how)\b/i.test(t)) return `${t}?`;
  // "On exam" / "In summary" are adverbial, not nouns, so "What is On exam?"
  // would be ungrammatical.
  if (/^(on|in|at|by|for|with|during|after|before)\b/i.test(t)) return `${t} — what was found?`;
  return `What ${be(t)} ${t}?`;
}

// ---------------------------------------------------------------------------
// Code and diagrams
// ---------------------------------------------------------------------------

/** Display names for the language tags parsers record. */
const LANGUAGE_NAMES: Record<string, string> = {
  bash: 'Bash',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  dart: 'Dart',
  go: 'Go',
  graphql: 'GraphQL',
  html: 'HTML',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  jsx: 'JSX',
  kotlin: 'Kotlin',
  markdown: 'Markdown',
  php: 'PHP',
  python: 'Python',
  ruby: 'Ruby',
  rust: 'Rust',
  scala: 'Scala',
  scss: 'Sass',
  sh: 'Shell',
  shell: 'Shell',
  sql: 'SQL',
  swift: 'Swift',
  tsx: 'TSX',
  typescript: 'TypeScript',
  xml: 'XML',
  yaml: 'YAML',
};

/** "cpp" -> "C++". Null for a tag with no name worth printing. */
export function languageName(language?: string): string | null {
  if (!language) return null;
  return LANGUAGE_NAMES[language.toLowerCase()] ?? null;
}

/**
 * Drops a list marker from the front of a label.
 *
 * Numbered subheadings are ordinary on tutorial pages — "1. Basic For Loop" —
 * and the number belongs to the article's running order, not to the concept.
 * Left in place it reads back as "What characterizes 1. Basic For Loop?".
 */
function stripOrdinal(label: string): string {
  return label.trim().replace(/^\(?\d{1,2}[.)]\s+/, '').trim() || label.trim();
}

/**
 * Question for a snippet the student should be able to write.
 *
 * The label is kept as its own noun phrase and the question asked after it,
 * rather than folded into "How do you write ...?". A label is a fragment with
 * no article of its own, and every attempt to build one produced a question
 * like "How do you write basic for loop in C++?".
 */
export function codeQuestion(label: string, language?: string): string {
  const l = stripOrdinal(label).replace(/[:?]+$/, '');
  const name = languageName(language);
  const suffix = name ? ` in ${name}` : '';
  if (/^(what|which|who|when|where|why|how)\b/i.test(l)) return `${l}?`;
  return `${l} — how is this written${suffix}?`;
}

/**
 * Question for a snippet whose printed output is the answer.
 *
 * The label leads, because a deck built from a tutorial holds a dozen of these
 * and "What does this program print?" is the same question every time — the
 * duplicate filter would keep one of them and drop the rest.
 */
export function outputQuestion(label?: string, language?: string): string {
  const name = languageName(language);
  const question = name ? `what does this ${name} program print?` : 'what does this program print?';
  const topic = label ? stripOrdinal(label).replace(/[:?]+$/, '') : '';
  if (!topic) return question.charAt(0).toUpperCase() + question.slice(1);
  return `${topic} — ${question}`;
}

/** Question for a diagram, where the picture itself is the answer. */
export function diagramQuestion(label: string): string {
  const l = stripOrdinal(label).replace(/[:?]+$/, '');
  if (/^(what|which|who|when|where|why|how)\b/i.test(l)) return `${l}?`;
  return `${l} — what does it look like?`;
}
