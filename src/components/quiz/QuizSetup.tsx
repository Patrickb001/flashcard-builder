import type { Deck, Flashcard, TestQuestion } from '../../types';
import type { AiSettings } from '../../lib/aiGenerator';
import AiSettingsPanel from '../AiSettingsPanel';
import { MIN_SLIDER_POOL } from './useDeckQuiz';

/**
 * Choosing what to be tested on.
 *
 * Also where the two things standing between a deck and a test are reported:
 * the AI helper being off, and cards that have no question yet.
 */
interface Props {
  deck: Deck;
  cards: Flashcard[];
  pool: TestQuestion[];
  unwritten: Flashcard[];
  ai: AiSettings;
  onAiChange: (settings: AiSettings) => void;
  notice: string | null;
  noticeFailed: boolean;
  count: number;
  onCountChange: (count: number) => void;
  onWriteMissing: () => void;
  onStart: () => void;
  onExit: () => void;
}

export default function QuizSetup({
  deck,
  cards,
  pool,
  unwritten,
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
            Tests are multiple choice, and the questions are written for you once and then kept. That
            first step needs the AI helper switched on — after that, taking a test works offline and
            costs nothing.
          </p>
          <AiSettingsPanel settings={ai} onChange={onAiChange} />
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
            <button className="secondary-btn" onClick={onWriteMissing}>
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
