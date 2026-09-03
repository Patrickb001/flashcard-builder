import type { QuizProgress } from '../../lib/quizGenerator';

interface Props {
  deckName: string;
  /** Batches done out of total, or null before the first one lands. */
  progress: QuizProgress | null;
  /**
   * Questions saved so far, counting this run and every earlier one. Shown
   * because stopping keeps them — see the component note below.
   */
  written: number;
  onStop: () => void;
}

/**
 * The screen shown while the model writes questions.
 *
 * It says how many are already saved, because they are saved as they arrive —
 * stopping here keeps everything written so far, and the message has to make
 * that clear or Stop reads as "throw this away".
 */
export default function QuizGenerating({ deckName, progress, written, onStop }: Props) {
  const pct = progress ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="quiz">
      <div className="study-header">
        <div>
          <p className="eyebrow">Preparing a test</p>
          <h1>{deckName}</h1>
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

      <p className="muted small">
        {written} questions written so far. These are saved as they arrive, so nothing is lost if you
        stop.
      </p>

      <div className="form-actions">
        <button className="ghost-btn" onClick={onStop}>
          Stop
        </button>
      </div>
    </div>
  );
}
