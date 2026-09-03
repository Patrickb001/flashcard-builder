import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Deck, Flashcard, QuestionStyle, TestQuestion } from '../../types';
import { styleOf } from '../../types';
import {
  getCardsForDeck,
  getDeck,
  getQuestionsForDeck,
  pruneOrphanQuestions,
  recordQuestionsAsked,
  saveQuestions,
} from '../../db/db';
import type { AiSettings } from '../../lib/aiGenerator';
import { loadAiSettings } from '../../lib/aiGenerator';
import { generateQuestionsForCards, hashCard, type QuizProgress } from '../../lib/quizGenerator';
import { prepareQuestions, selectQuestions, type PreparedQuestion } from '../../lib/quizSelection';

/**
 * Everything a test needs to run, with none of its layout.
 *
 * A test spans four screens — setup, generating, taking, results — and the
 * question pool has to survive all of them, so the state and the transitions
 * between phases live here and each screen renders one phase of it.
 */

export type Phase = 'loading' | 'setup' | 'generating' | 'taking' | 'results';

/** Below this many questions a slider has nothing useful to offer. */
export const MIN_SLIDER_POOL = 5;
const DEFAULT_COUNT = 20;

export function useDeckQuiz(deckId: string) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [deck, setDeck] = useState<Deck | null>(null);
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [pool, setPool] = useState<TestQuestion[]>([]);
  const [ai, setAi] = useState<AiSettings>({ mode: 'off' });

  const [progress, setProgress] = useState<QuizProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeFailed, setNoticeFailed] = useState(false);

  /**
   * Which style the setup screen is currently showing.
   *
   * The pool holds both styles at once; this is the lens onto it. Every screen
   * below reads the filtered slice, never the whole pool, so switching the
   * picker switches the test rather than mixing recall questions into a board
   * paper.
   */
  const [style, setStyle] = useState<QuestionStyle>('recall');

  const [count, setCount] = useState(DEFAULT_COUNT);
  const [asked, setAsked] = useState<PreparedQuestion[]>([]);
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [position, setPosition] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  /** The questions in the style currently selected. Everything below reads this. */
  const visiblePool = useMemo(
    () => pool.filter((question) => styleOf(question) === style),
    [pool, style]
  );

  /**
   * Cards whose question is missing, or was written from different text.
   *
   * Both are offered together, because to the reader they are the same thing:
   * this card will not come up in the test as it stands.
   *
   * Memoised because hashing every card in the deck on every render is real
   * work for a value only the setup screen reads.
   */
  const unwritten = useMemo(() => {
    // Keyed on card AND style. Keyed on card alone, the two styles of the same
    // card overwrite each other and "cards without a question" goes wrong in
    // both directions — offering cards that are already written, and hiding
    // cards that are not.
    const byCard = new Map(
      pool.map((question) => [`${question.cardId}:${styleOf(question)}`, question])
    );
    return cards.filter((card) => {
      const question = byCard.get(`${card.id}:${style}`);
      return !question || question.cardHash !== hashCard(card);
    });
  }, [cards, pool, style]);

  const load = useCallback(async () => {
    const [loadedDeck, loadedCards] = await Promise.all([getDeck(deckId), getCardsForDeck(deckId)]);
    // A question whose card is gone would still be asked. The delete cascade
    // handles this; the sweep is here for any deck left behind by an earlier
    // build, and costs one index scan.
    await pruneOrphanQuestions(deckId, new Set(loadedCards.map((card) => card.id)));
    const loadedPool = await getQuestionsForDeck(deckId);

    setDeck(loadedDeck ?? null);
    setCards(loadedCards);
    setPool(loadedPool);
    setAi(loadAiSettings());
    // The deck is returned as well as stored, so the caller below does not have
    // to read it from the database a second time in the same mount.
    return { deck: loadedDeck ?? null, cards: loadedCards, pool: loadedPool };
  }, [deckId]);

  /** Writes questions for the given cards, saving each batch as it lands. */
  const generate = useCallback(
    async (
      targets: Flashcard[],
      allCards: Flashcard[],
      deckName: string,
      settings: AiSettings,
      forStyle: QuestionStyle = 'recall'
    ) => {
      if (targets.length === 0) return;

      const controller = new AbortController();
      abortRef.current = controller;
      setPhase('generating');
      setProgress(null);
      setNotice(null);
      setNoticeFailed(false);

      const result = await generateQuestionsForCards(targets, allCards, deckName, settings, {
        style: forStyle,
        onProgress: setProgress,
        // Saved per batch, so a run interrupted at batch seven of twelve keeps
        // the first sixty questions rather than throwing them away.
        onBatch: async (batch) => {
          await saveQuestions(batch);
          setPool((prev) => [...prev, ...batch]);
        },
        signal: controller.signal,
      });

      abortRef.current = null;

      // Stopping is a choice, not a failure. Whatever was written is saved,
      // and the rest stay as cards without a question.
      if (result.aborted) {
        setNoticeFailed(false);
        setNotice(
          result.questions.length > 0
            ? `Stopped. ${result.questions.length} question${result.questions.length === 1 ? '' : 's'} were written and saved.`
            : 'Stopped before any questions were written.'
        );
        setPhase('setup');
        return;
      }

      const missed = new Set(result.failedCardIds).size;
      // Two different causes need two different sentences. A truncated reply is
      // the tool hitting its own length limit and is worth retrying as-is; a card
      // the model declined is a property of that card. Blaming the cards for a
      // truncation sent people editing decks that were never the problem.
      const truncated = result.truncatedBatches > 0;
      if (result.questions.length === 0) {
        setNoticeFailed(true);
        setNotice(`No questions could be written. ${result.firstError ?? ''}`.trim());
      } else if (missed > 0) {
        setNoticeFailed(false);
        const plural = missed === 1 ? '' : 's';
        const reason = truncated
          ? `${missed} card${plural} ${missed === 1 ? 'was' : 'were'} left out because the reply ran into its length limit`
          : `${missed} card${plural} could not be turned into a fair question`;
        setNotice(
          `Wrote ${result.questions.length} questions. ${reason} — try again to fill ${missed === 1 ? 'it' : 'them'} in.`
        );
      }

      setPhase('setup');
    },
    []
  );

  /*
   * First load. Always lands on setup; writing questions is never automatic,
   * even for a deck with no questions yet.
   *
   * Generating on mount would start spending before the screen that offers the
   * style choice had rendered, leaving someone who wanted board-style items to
   * press Stop on a batch of recall questions they had already paid for.
   */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await load();
        if (cancelled) return;
        setPhase('setup');
      } catch (err) {
        // Without this the screen stayed on the loading phase for good.
        if (cancelled) return;
        console.error('[test] Could not open the deck:', err);
        setNoticeFailed(true);
        setNotice('This deck could not be read from the browser database.');
        setPhase('setup');
      }
    })();

    return () => {
      cancelled = true;
      // Batches already saved survive; the rest become cards without a
      // question, which the top-up prompt already knows how to offer.
      abortRef.current?.abort();
    };
  }, [deckId, load]);

  // Keep the requested count inside what the selected style can actually supply.
  useEffect(() => {
    if (visiblePool.length === 0) return;
    setCount((current) => Math.min(Math.max(current, 1), visiblePool.length));
  }, [visiblePool.length]);

  const startTest = useCallback(() => {
    const drawn = selectQuestions(visiblePool, Math.min(count, visiblePool.length));
    setAsked(prepareQuestions(drawn));
    setAnswers(new Array(drawn.length).fill(null));
    setPosition(0);
    setSelected(null);
    setPhase('taking');
  }, [visiblePool, count]);

  /**
   * Commits the current answer and moves on.
   *
   * The counter is written here rather than at the end of the test, so quitting
   * after three of ten still counts those three and the next test moves past
   * them. Questions drawn but never reached stay untouched, which is what makes
   * an abandoned test harmless.
   */
  const commitAnswer = useCallback(() => {
    if (selected === null) return;
    const current = asked[position];
    const correct = selected === current.correctIndex;

    setAnswers((prev) => prev.map((a, i) => (i === position ? selected : a)));
    void recordQuestionsAsked([{ questionId: current.question.id, correct }]).catch((err) =>
      console.error('Could not record the answer:', err)
    );

    setSelected(null);
    if (position + 1 >= asked.length) setPhase('results');
    else setPosition((p) => p + 1);
  }, [selected, asked, position]);

  const cardFor = useCallback(
    (question: TestQuestion) => cards.find((card) => card.id === question.cardId),
    [cards]
  );

  const stopGenerating = useCallback(() => abortRef.current?.abort(), []);

  return {
    phase,
    setPhase,
    deck,
    cards,
    pool,
    /** The selected style's slice of the pool — what every screen should read. */
    visiblePool,
    style,
    setStyle,
    ai,
    setAi,
    progress,
    notice,
    noticeFailed,
    count,
    setCount,
    asked,
    answers,
    position,
    selected,
    setSelected,
    unwritten,
    generate,
    startTest,
    commitAnswer,
    cardFor,
    stopGenerating,
  };
}
