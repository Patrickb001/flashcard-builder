/**
 * One saved deck, as the library lists it.
 *
 * Holds no cards itself — those live in their own store keyed by `deckId`, so
 * opening the library does not read every card in every deck.
 */
export interface Deck {
  id: string;
  name: string;
  /** The document this came from, shown on the manage screen. */
  sourceFileName: string;
  sourceType: SourceType;
  /**
   * The page address(es) a web-sourced deck was built from, in the order they
   * were read. Absent for a deck built from an uploaded file, and for every
   * deck saved before this field existed.
   */
  sourceUrls?: string[];
  createdAt: number;
  /**
   * Cards in this deck, kept in step by addCard and deleteCard so the library
   * can show a count without reading the cards themselves.
   */
  cardCount: number;
  /**
   * The folder this deck is filed in. Absent means Unfiled — which is every
   * deck saved before folders existed, so there is nothing to migrate.
   *
   * Never read this directly to decide where a deck belongs: it can name a
   * folder another tab has since deleted. Go through folderOf in
   * lib/deckFolders, which treats that as Unfiled.
   */
  folderId?: string;
}

/**
 * A named group of decks, one level deep.
 *
 * Holds no deck ids. Decks point at their folder instead, so moving a deck is
 * one write and deleting a deck never has to touch a folder.
 */
export interface Folder {
  id: string;
  name: string;
  createdAt: number;
}

/**
 * How much content to ask for. A prompt-shaping choice, not a stored render
 * setting the view screen reads — but it's kept on the record because the
 * infographics list shows it.
 */
export type InfographicDetail = 'basic' | 'standard' | 'detailed';

/**
 * One saved infographic. A deck can have any number of these — different
 * detail levels or card subsets are different infographics, not versions of
 * one, so there is no "the deck's infographic" singular and no overwrite.
 *
 * `html` is the model's own self-contained HTML document — inline CSS and
 * inline SVG, no external JS or images (see infographicPrompt.ts). It is
 * rendered through a sandboxed iframe (InfographicView.tsx), never through
 * this app's own DOM.
 */
export interface Infographic {
  id: string;
  deckId: string;
  title: string;
  detail: InfographicDetail;
  html: string;
  /** Which cards this one was built from, for the list screen's "N cards" line. */
  cardIds: string[];
  createdAt: number;
}

/** Which kind of document a deck was built from. */
export type SourceType = 'pdf' | 'pptx' | 'md' | 'html';

/**
 * How the reader last answered a card.
 *
 * Superseded by `srs` for every scheduling decision, and kept in step by
 * applyGrade only so records stay readable by anything that still looks at it.
 */
export type CardStatus = 'new' | 'known' | 'unknown';

/**
 * Where a card sits in the spaced-repetition schedule.
 *
 * Absent on a card that has never been graded — which is every card saved
 * before scheduling existed, so there is nothing to migrate: absent means new.
 * Written only by applyGrade in lib/scheduling; never build one by hand.
 */
export interface CardSchedule {
  /** When the card next comes up, as epoch ms. Due once this falls before the end of today. */
  due: number;
  /** Days between the last review and `due`. 0 while the card is being (re)learned. */
  intervalDays: number;
  /** SM-2 ease factor: how fast the interval grows. Starts at 2.5, never below 1.3. */
  ease: number;
  /** Successful reviews in a row. 0 means new or relearning after a lapse. */
  reps: number;
  /** Times the card was forgotten after it had been learned. */
  lapses: number;
  lastReviewedAt: number;
}

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

/** One saved card. The unit everything else in the app is built from. */
export interface Flashcard extends CardMedia {
  id: string;
  deckId: string;
  front: string;
  back: string;
  /** Where in the document this came from, e.g. "Page 3" or "Slide 5". */
  sourceLabel: string;
  /** The section/slide title the card came from, shown as a topic on the card. */
  context?: string;
  status: CardStatus;
  createdAt: number;
  /**
   * Where the card sits in its deck, 0-based, as the review screen left it.
   *
   * Timestamps cannot carry this: a save writes every card with the same
   * `Date.now()`, so sorting on `createdAt` sorts a set of equal keys and the
   * cards come back in IndexedDB's own order — by random UUID, which reads as a
   * shuffle. This is the position the deck was saved in, kept explicitly.
   *
   * Absent on every card written before the field existed; getCardsForDeck
   * falls back to `createdAt` for those decks rather than forcing a migration.
   */
  order?: number;
  /** The card's place in the review schedule. Absent means never graded; see CardSchedule. */
  srs?: CardSchedule;
}

/**
 * A drafted card on the review screen, before it is saved.
 *
 * Deliberately not a Flashcard: it has no id and no deck, because it may never
 * become one. `include` is the checkbox, so unchecking a card keeps it on screen
 * to be reconsidered rather than deleting it.
 */
export interface CandidateCard extends CardMedia {
  front: string;
  back: string;
  sourceLabel: string;
  /** The section/slide title the card came from, shown as a topic on the card. */
  context?: string;
  /** Whether this card is currently checked for saving. */
  include: boolean;
  /** Set on a card from the deterministic fallback; absent (not `false`) for an AI-drafted one. */
  origin?: 'rule-based';
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
  /**
   * How many times this has been put in front of the user. Read by the question
   * picker, which tiers by it so nothing repeats until everything has been asked.
   */
  timesAsked: number;
  /** Written on every answer and read nowhere, as is timesCorrect. Kept
   * deliberately: removing them costs an IndexedDB migration for no gain. */
  lastAskedAt: number | null;
  timesCorrect: number;
  /**
   * Whether the most recent answer to this question was right. Absent until it
   * has been answered once under a build that records it. selectQuestions gives
   * questions with `false` here priority, so a miss comes back.
   */
  lastCorrect?: boolean;
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
