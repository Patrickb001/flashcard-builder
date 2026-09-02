export interface Deck {
  id: string;
  name: string;
  sourceFileName: string;
  sourceType: 'pdf' | 'pptx' | 'md' | 'html';
  createdAt: number;
  cardCount: number;
}

export type CardStatus = 'new' | 'known' | 'unknown';

/**
 * A snippet shown on a card face.
 *
 * Code is carried beside the text rather than pasted into it. A question like
 * "what does this print?" needs the program laid out with its indentation
 * intact, and a card that has folded it into a sentence cannot show that.
 */
export interface CardCode {
  text: string;
  language?: string;
}

/** A diagram shown on the answer side, carried by address. */
export interface CardImage {
  src: string;
  alt?: string;
}

/** The parts a card can carry beyond its two lines of text. */
interface CardMedia {
  /** A snippet the question is about — the program a card asks you to read. */
  frontCode?: CardCode;
  /** A snippet that is the answer — the syntax a card asks you to recall. */
  backCode?: CardCode;
  /** A diagram that answers the question, shown on the back. */
  image?: CardImage;
}

export interface Flashcard extends CardMedia {
  id: string;
  deckId: string;
  front: string;
  back: string;
  sourceLabel: string; // e.g. "Page 3" or "Slide 5"
  /** The section/slide title the card came from, shown as a topic on the card. */
  context?: string;
  status: CardStatus;
  createdAt: number;
}

export interface CandidateCard extends CardMedia {
  front: string;
  back: string;
  sourceLabel: string;
  /** The section/slide title the card came from, shown as a topic on the card. */
  context?: string;
  include: boolean;
}

/**
 * Which kind of question this is.
 *
 * "recall" rewords the card's front and asks for its back — good for retention,
 * and what this app wrote before there was a choice. "vignette" is a PANCE-style
 * item: a short clinical scenario, a lead-in question, and five homogeneous
 * options.
 *
 * Stored as an OPTIONAL field, and absent means "recall". Every question written
 * before this existed reads back with no style, and reading it through styleOf
 * below is what lets those keep working without an IndexedDB migration.
 */
export type QuestionStyle = 'recall' | 'vignette';

/**
 * One multiple-choice question, written once from a flashcard and kept.
 *
 * Grading is a string comparison against `correctAnswer`, so taking a test costs
 * no model call at all — which is the whole reason the pool is stored rather
 * than drafted fresh each time.
 *
 * The right answer and the wrong ones are held apart rather than as an options
 * array plus an index. An index is a second thing that can be wrong, and it has
 * to survive the parser, the database round-trip and the shuffle before every
 * draw. Kept apart, the record describes itself, and shuffling on presentation
 * becomes the only thing the shape can express — so a model that habitually
 * lists the correct answer first cannot leak that into the test.
 */
export interface TestQuestion {
  id: string;
  deckId: string;
  /** The flashcard this came from. Deleting that card deletes this. */
  cardId: string;

  /** Absent on everything written before the second style existed; see styleOf. */
  style?: QuestionStyle;

  /**
   * The clinical scenario a vignette question opens with, when it has one.
   *
   * Kept apart from the stem rather than folded into it. The stem stays the
   * lead-in question either way, so grading, selection and shuffling never have
   * to know which style they are handling, and a recall question is simply one
   * with no vignette. A PANCE item whose fact cannot carry a scenario without
   * inventing findings has none either — see the escape hatch in the prompt.
   */
  vignette?: string;

  /** A self-contained question. Never "which of the above…". */
  stem: string;
  correctAnswer: string;
  /** Wrong answers, each distinct from the others and from the correct one. */
  distractors: string[];
  /** One sentence, written with the question, shown only when it is missed. */
  explanation: string;

  /**
   * Media copied straight from the source card, never routed through the model.
   * A question about a program is unanswerable without the program in front of
   * you, so the snippet travels with the question.
   */
  stemCode?: CardCode;
  stemImage?: CardImage;
  context?: string;
  sourceLabel: string;

  /**
   * Fingerprint of the source card's front and back when this was written.
   *
   * A content hash rather than a timestamp: the deck manager saves a card on
   * every textarea blur, including blurs that changed nothing, so a timestamp
   * would call a question stale because somebody tabbed through the field.
   */
  cardHash: string;

  createdAt: number;
  /** How many times this has been put in front of the user; drives selection. */
  /** Read by the question picker, which tiers by how often each was asked. */
  timesAsked: number;
  /**
   * Written on every answer and read nowhere, as is timesCorrect.
   *
   * Kept deliberately. Removing them means an IndexedDB migration for no
   * user-visible gain, and they cost two numbers inside a write that happens
   * anyway. Left here so the next reader does not rediscover them as dead
   * weight and pay that price to remove them.
   */
  lastAskedAt: number | null;
  timesCorrect: number;
}

/**
 * A question's style, defaulting the ones written before styles existed.
 *
 * The default lives here and nowhere else. Reading `q.style` directly anywhere
 * is a bug waiting to happen: every question in every deck built before this
 * feature has the field undefined, and a `=== 'recall'` test against those
 * silently drops the whole existing pool out of the test.
 */
export function styleOf(question: Pick<TestQuestion, 'style'>): QuestionStyle {
  return question.style ?? 'recall';
}
