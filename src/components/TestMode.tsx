import { useCallback, useEffect, useRef, useState } from 'react';
import type { Deck, Flashcard, TestQuestion } from '../types';
import {
  getCardsForDeck,
  getDeck,
  getQuestionsForDeck,
  pruneOrphanQuestions,
  recordQuestionsAsked,
  saveQuestions,
} from '../db/db';
import type { AiSettings } from '../lib/aiGenerator';
import { loadAiSettings } from '../lib/aiGenerator';
import { generateQuestionsForCards, hashCard, type QuizProgress } from '../lib/quizGenerator';
import { prepareQuestions, selectQuestions, type PreparedQuestion } from '../lib/quizSelection';
import AiSettingsPanel from './AiSettingsPanel';
import { Diagram, Snippet } from './CardMedia';

interface Props {
  deckId: string;
  onExit: () => void;
}

/**
 * Testing a deck, from writing the questions to marking the paper.
 *
 * One component with a phase, rather than several: the question pool has to
 * survive the move from setup to test to results, and App holds no domain state
 * to lift it into.
 *
 * Questions are written once by the model and kept, so taking a test costs
 * nothing and works offline — the whole screen makes no network request after
 * the pool exists.
 */
type Phase = 'loading' | 'setup' | 'generating' | 'taking' | 'results';

/** Below this many questions a slider has nothing useful to offer. */
const MIN_SLIDER_POOL = 5;
const DEFAULT_COUNT = 20;

export default function TestMode({ deckId, onExit }: Props) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [deck, setDeck] = useState<Deck | null>(null);
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [pool, setPool] = useState<TestQuestion[]>([]);
  const [ai, setAi] = useState<AiSettings>({ mode: 'off' });

  const [progress, setProgress] = useState<QuizProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeFailed, setNoticeFailed] = useState(false);

  const [count, setCount] = useState(DEFAULT_COUNT);
  const [asked, setAsked] = useState<PreparedQuestion[]>([]);
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [position, setPosition] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // Cards whose question is missing, or was written from different text. Both
  // are offered together, because to the reader they are the same thing: this
  // card will not come up in the test as it stands.
  const byCard = new Map(pool.map((q) => [q.cardId, q]));
  const unwritten = cards.filter((card) => {
    const question = byCard.get(card.id);
    return !question || question.cardHash !== hashCard(card);
  });

  const load = useCallback(async () => {
    const [loadedDeck, loadedCards] = await Promise.all([getDeck(deckId), getCardsForDeck(deckId)]);
    // A question whose card is gone would still be asked. The delete cascade
    // handles this; the sweep is here for any deck left behind by an earlier
    // build, and costs one index scan.
    await pruneOrphanQuestions(deckId, new Set(loadedCards.map((c) => c.id)));
    const loadedPool = await getQuestionsForDeck(deckId);

    setDeck(loadedDeck ?? null);
    setCards(loadedCards);
    setPool(loadedPool);
    setAi(loadAiSettings());
    return { cards: loadedCards, pool: loadedPool };
  }, [deckId]);

  /** Writes questions for the given cards, saving each batch as it lands. */
  const generate = useCallback(
    async (targets: Flashcard[], allCards: Flashcard[], deckName: string, settings: AiSettings) => {
      if (targets.length === 0) return;

      const controller = new AbortController();
      abortRef.current = controller;
      setPhase('generating');
      setProgress(null);
      setNotice(null);
      setNoticeFailed(false);

      const result = await generateQuestionsForCards(targets, allCards, deckName, settings, {
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
        setNotice(
          `No questions could be written. ${result.firstError ?? ''}`.trim()
        );
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

  // First load. A deck with cards but no questions at all goes straight into
  // generation — that is what clicking "Test this deck" asked for. It lands on
  // setup afterwards rather than starting, because the number of questions is
  // the user's to choose.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { cards: loadedCards, pool: loadedPool } = await load();
        if (cancelled) return;

        const settings = loadAiSettings();
        if (loadedPool.length === 0 && loadedCards.length > 0 && settings.mode !== 'off') {
          const name = (await getDeck(deckId))?.name ?? 'this deck';
          if (!cancelled) await generate(loadedCards, loadedCards, name, settings);
        } else {
          setPhase('setup');
        }
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
  }, [deckId, load, generate]);

  // Keep the requested count inside what the pool can actually supply.
  useEffect(() => {
    if (pool.length === 0) return;
    setCount((current) => Math.min(Math.max(current, 1), pool.length));
  }, [pool.length]);

  const startTest = () => {
    const drawn = selectQuestions(pool, Math.min(count, pool.length));
    setAsked(prepareQuestions(drawn));
    setAnswers(new Array(drawn.length).fill(null));
    setPosition(0);
    setSelected(null);
    setPhase('taking');
  };

  /**
   * Commits the current answer and moves on.
   *
   * The counter is written here rather than at the end of the test, so quitting
   * after three of ten still counts those three and the next test moves past
   * them. Questions drawn but never reached stay untouched, which is what makes
   * an abandoned test harmless.
   */
  const commitAnswer = () => {
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
  };

  const cardFor = (question: TestQuestion) => cards.find((c) => c.id === question.cardId);

  // -------------------------------------------------------------------------
  // Loading and generation
  // -------------------------------------------------------------------------

  if (phase === 'loading') return <p className="muted">Loading deck…</p>;
  // A deck that is absent and a deck that could not be read are different
  // things, and saying "couldn't be found" for a storage failure sends people
  // looking for a deck that is sitting right there.
  if (!deck && noticeFailed && notice)
    return (
      <div className="ai-notice failed">
        <strong>This deck could not be opened</strong>
        <p>{notice}</p>
      </div>
    );
  if (!deck) return <p className="muted">This deck couldn't be found.</p>;

  if (phase === 'generating') {
    const pct = progress ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
      <div className="quiz">
        <div className="study-header">
          <div>
            <p className="eyebrow">Preparing a test</p>
            <h1>{deck.name}</h1>
          </div>
        </div>
        <div className="drafting-banner">
          <span className="chalk-spinner small" aria-hidden="true" />
          <span>
            Claude is writing test questions
            {progress ? ` — batch ${progress.done} of ${progress.total}` : '…'}
          </span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <p className="muted small">{pool.length} questions written so far. These are saved as they arrive, so nothing is lost if you stop.</p>
        <div className="form-actions">
          <button className="ghost-btn" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  if (phase === 'setup') {
    if (cards.length === 0) {
      return (
        <div className="study-empty">
          <p className="muted">This deck has no cards to test you on.</p>
          <button className="ghost-btn" onClick={onExit}>
            Back to library
          </button>
        </div>
      );
    }

    const sliderMin = Math.min(MIN_SLIDER_POOL, pool.length);
    const showSlider = pool.length >= MIN_SLIDER_POOL;

    return (
      <div className="quiz quiz-setup">
        <div className="study-header">
          <div>
            <p className="eyebrow">Testing</p>
            <h1>{deck.name}</h1>
          </div>
        </div>

        {notice && (
          <div className={`ai-notice ${noticeFailed ? 'failed' : 'partial'}`} role="alert">
            <strong>{noticeFailed ? 'No questions were written' : 'Some cards were left out'}</strong>
            <span>{notice}</span>
          </div>
        )}

        {ai.mode === 'off' && (
          <div className="quiz-ai-gate">
            <p className="muted">
              Tests are multiple choice, and the questions are written for you once and then kept.
              That first step needs the AI helper switched on — after that, taking a test works
              offline and costs nothing.
            </p>
            <AiSettingsPanel settings={ai} onChange={setAi} />
          </div>
        )}

        {ai.mode !== 'off' && unwritten.length > 0 && (
          <div className="ai-notice partial" role="status">
            <strong>Some questions are missing</strong>
            <span>
              {unwritten.length} card{unwritten.length === 1 ? ' has' : 's have'} no test question yet,
              or changed since {unwritten.length === 1 ? 'its was' : 'theirs were'} written.
            </span>
            <div className="form-actions">
              <button
                className="secondary-btn"
                onClick={() => generate(unwritten, cards, deck.name, ai)}
              >
                Write them ({unwritten.length})
              </button>
            </div>
          </div>
        )}

        {pool.length === 0 ? (
          <p className="muted">
            {ai.mode === 'off'
              ? 'Turn on the AI helper above to write this deck’s questions.'
              : 'There are no questions for this deck yet.'}
          </p>
        ) : (
          <>
            {showSlider ? (
              <div className="quiz-count-row">
                <label htmlFor="quiz-count">How many questions?</label>
                <input
                  id="quiz-count"
                  type="range"
                  min={sliderMin}
                  max={pool.length}
                  step={1}
                  value={Math.min(count, pool.length)}
                  onChange={(e) => setCount(Number(e.target.value))}
                />
                <span className="quiz-count-value">{Math.min(count, pool.length)}</span>
              </div>
            ) : (
              <p className="muted">
                Short test — this deck only makes {pool.length} question
                {pool.length === 1 ? '' : 's'} so far.
              </p>
            )}
            <p className="muted small">
              Drawn from {pool.length} question{pool.length === 1 ? '' : 's'}, favouring the ones you
              have seen least.
            </p>
          </>
        )}

        <div className="form-actions">
          <button className="ghost-btn" onClick={onExit}>
            Back to library
          </button>
          <button className="primary-btn" onClick={startTest} disabled={pool.length === 0}>
            Start test
          </button>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Taking the test
  // -------------------------------------------------------------------------

  if (phase === 'taking') {
    const current = asked[position];
    const card = cardFor(current.question);
    const pct = Math.round((position / asked.length) * 100);
    const last = position + 1 >= asked.length;

    return (
      <div className="quiz">
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>

        <p className="muted small centered">
          Question {position + 1} of {asked.length} · {current.question.sourceLabel}
        </p>

        <div className="quiz-question">
          {current.question.context && (
            <span className="topic-chip">{current.question.context}</span>
          )}
          <p className="quiz-stem">{current.question.stem}</p>
          {current.question.stemCode && <Snippet code={current.question.stemCode} />}
          {current.question.stemImage && <Diagram image={current.question.stemImage} />}
          {!current.question.stemCode && card?.frontCode && <Snippet code={card.frontCode} />}
        </div>

        <ul className="quiz-options" role="radiogroup" aria-label="Answer options">
          {current.options.map((option, i) => (
            <li key={i}>
              <button
                type="button"
                role="radio"
                aria-checked={selected === i}
                className={`quiz-option ${selected === i ? 'selected' : ''}`}
                onClick={() => setSelected(i)}
              >
                <span className="quiz-option-key">{String.fromCharCode(65 + i)}</span>
                <span>{option}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="form-actions">
          <button
            className="ghost-btn"
            onClick={() => {
              if (confirm('End this test? Your answers so far will not be scored.')) onExit();
            }}
          >
            Exit test
          </button>
          <button className="primary-btn" onClick={commitAnswer} disabled={selected === null}>
            {last ? 'Finish test' : 'Next question'}
          </button>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------

  const correctCount = asked.reduce(
    (n, q, i) => n + (answers[i] === q.correctIndex ? 1 : 0),
    0
  );
  const pct = asked.length === 0 ? 0 : Math.round((correctCount / asked.length) * 100);
  const missed = asked.filter((q, i) => answers[i] !== q.correctIndex);

  return (
    <div className="quiz">
      <div className="study-summary">
        <h2 className="quiz-score">
          {correctCount} of {asked.length}
        </h2>
        <p className="muted">{pct}% correct</p>
      </div>

      {missed.length === 0 ? (
        <p className="muted centered">Clean sheet — every answer correct.</p>
      ) : (
        <>
          <p className="eyebrow">
            Review — {missed.length} missed
          </p>
          <ul className="quiz-review">
            {missed.map((prepared) => {
              const index = asked.indexOf(prepared);
              const picked = answers[index];
              const card = cardFor(prepared.question);
              return (
                <li className="quiz-review-row" key={prepared.question.id}>
                  <p className="quiz-stem">{prepared.question.stem}</p>
                  {prepared.question.stemCode && <Snippet code={prepared.question.stemCode} />}
                  {prepared.question.stemImage && <Diagram image={prepared.question.stemImage} />}

                  <p className="quiz-answer-line picked">
                    <span className="quiz-answer-tag">You chose</span>
                    {picked === null ? 'nothing' : prepared.options[picked]}
                  </p>
                  <p className="quiz-answer-line correct">
                    <span className="quiz-answer-tag">Answer</span>
                    {prepared.question.correctAnswer}
                  </p>
                  <p className="quiz-explanation">{prepared.question.explanation}</p>
                  {card && (
                    <p className="muted small">
                      From the card: {card.front} — {card.back}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="form-actions">
        <button className="ghost-btn" onClick={onExit}>
          Back to library
        </button>
        <button className="primary-btn" onClick={() => setPhase('setup')}>
          Test again
        </button>
      </div>
    </div>
  );
}
