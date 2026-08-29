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
