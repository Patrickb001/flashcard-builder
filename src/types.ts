export interface Deck {
  id: string;
  name: string;
  sourceFileName: string;
  sourceType: 'pdf' | 'pptx';
  createdAt: number;
  cardCount: number;
}

export type CardStatus = 'new' | 'known' | 'unknown';

export interface Flashcard {
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

export interface CandidateCard {
  front: string;
  back: string;
  sourceLabel: string;
  /** The section/slide title the card came from, shown as a topic on the card. */
  context?: string;
  include: boolean;
}
