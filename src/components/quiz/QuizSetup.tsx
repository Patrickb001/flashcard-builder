import type { Deck, Flashcard, QuestionStyle, TestQuestion } from '../../types';
import type { AiSettings } from '../../lib/aiGenerator';
import AiSettingsPanel from '../AiSettingsPanel';
import ScreenHeader from '../ui/ScreenHeader';
import { MIN_SLIDER_POOL } from './useDeckQuiz';

interface Props {
  /** The deck being tested; only its name and card count are shown. */
  deck: Deck;
  /** Every card in the deck, for the "n of m cards" counts. */
  cards: Flashcard[];
  /** Already narrowed to the selected style by the hook. */
  pool: TestQuestion[];
  /**
   * Cards with no question in the selected style, or whose question was written
   * from text that has since changed. Both mean the same thing to the reader —
   * this card will not come up — so they are offered together.
   */
  unwritten: Flashcard[];
  style: QuestionStyle;
  onStyleChange: (style: QuestionStyle) => void;
  ai: AiSettings;
  onAiChange: (settings: AiSettings) => void;
  /** Outcome of the last generation run, shown above the controls. */
  notice: string | null;
  /** Whether that notice is a failure, which colours it. */
  noticeFailed: boolean;
  /** How many questions the test will ask. */
  count: number;
  onCountChange: (count: number) => void;
  /** Starts a generation run for the unwritten cards. Costs a model call. */
  onWriteMissing: () => void;
  onStart: () => void;
  onExit: () => void;
}

/** The two styles, as the picker offers them. */
const STYLES: { id: QuestionStyle; name: string; blurb: string }[] = [
  { id: 'recall', name: 'Recall', blurb: 'One fact per question, four options' },
  { id: 'vignette', name: 'PANCE style', blurb: 'Clinical vignettes, five options' },
];

/**
 * Choosing what to be tested on: the question style, how many, and whether to
 * write questions for the cards that have none.
 *
 * Also where the two things standing between a deck and a test are reported —
 * the AI helper being off, and cards with no question yet. Nothing here spends
 * money on its own; writing questions is always an explicit button press.
 */
export default function QuizSetup({
  deck,
  cards,
  pool,
  unwritten,
  style,
  onStyleChange,
  ai,
  onAiChange,
  notice,
  noticeFailed,
  count,
  onCountChange,
  onWriteMissing,
  onStart,
  onExit,
}: Props) {
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
  const styleNoun = style === 'vignette' ? 'PANCE-style' : 'recall';

  return (
    <div className="quiz quiz-setup">
      <ScreenHeader eyebrow="Testing" title={deck.name} />

      {notice && (
        <div className={`ai-notice ${noticeFailed ? 'failed' : 'partial'}`} role="alert">
          <strong>{noticeFailed ? 'No questions were written' : 'Some cards were left out'}</strong>
          <span>{notice}</span>
        </div>
      )}

      <div className="quiz-style-row" role="radiogroup" aria-label="Question style">
        {STYLES.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={style === option.id}
            className={`quiz-style-option ${style === option.id ? 'selected' : ''}`}
            onClick={() => onStyleChange(option.id)}
          >
            <span className="quiz-style-name">{option.name}</span>
            <span className="quiz-style-blurb">{option.blurb}</span>
          </button>
        ))}
      </div>

      {style === 'vignette' && (
        <p className="muted small">
          Written from this deck only — the scenarios use your own lecture material and nothing
          else. Worth checking a few against the source; the review screen shows the card each
          question came from.
        </p>
      )}

      {ai.mode === 'off' && (
        <div className="quiz-ai-gate">
          <p className="muted">
            Questions are written for you once and then kept. That first step needs the AI helper
            switched on — after that, taking a test works offline and costs nothing.
          </p>
          <AiSettingsPanel settings={ai} onChange={onAiChange} />
        </div>
      )}

      {/* Nothing is written until this is pressed. When the pool is empty this
          is the only thing to do on the screen, so it leads rather than sitting
          in a notice; once there is a pool it is a top-up and steps back. */}
      {ai.mode !== 'off' && unwritten.length > 0 && (
        <div className={`ai-notice ${pool.length === 0 ? 'partial quiz-write-cta' : 'partial'}`} role="status">
          <strong>
            {pool.length === 0
              ? `No ${styleNoun} questions for this deck yet`
              : 'Some questions are missing'}
          </strong>
          <span>
            {pool.length === 0
              ? `Writing them calls the AI helper once per batch. After that this test works offline and costs nothing.`
              : `${unwritten.length} card${unwritten.length === 1 ? ' has' : 's have'} no ${styleNoun} question yet, or changed since ${unwritten.length === 1 ? 'its was' : 'theirs were'} written.`}
          </span>
          <div className="form-actions">
            <button
              className={pool.length === 0 ? 'primary-btn' : 'secondary-btn'}
              onClick={onWriteMissing}
            >
              Write {unwritten.length} {styleNoun} question{unwritten.length === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      )}

      {pool.length === 0 ? (
        ai.mode === 'off' ? (
          <p className="muted">Turn on the AI helper above to write this deck’s questions.</p>
        ) : null
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
                onChange={(e) => onCountChange(Number(e.target.value))}
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
        <button className="primary-btn" onClick={onStart} disabled={pool.length === 0}>
          Start test
        </button>
      </div>
    </div>
  );
}
