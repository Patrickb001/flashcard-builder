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
  timesAsked: number;
  lastAskedAt: number | null;
  timesCorrect: number;
}
