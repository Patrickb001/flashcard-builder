import type { QuizProgress } from '../../lib/quizGenerator';
import DraftingBanner from '../ui/DraftingBanner';
import ProgressBar from '../ui/ProgressBar';
import ScreenHeader from '../ui/ScreenHeader';

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
  return (
    <div className="quiz">
      <ScreenHeader eyebrow="Preparing a test" title={deckName} />

      <DraftingBanner activity="writing test questions" progress={progress} />

      <ProgressBar fraction={progress ? progress.done / progress.total : 0} />

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
