import type { BatchProgress } from '../../lib/batchRunner';

interface Props {
  /** What Claude is doing, e.g. "drafting cards". Reads after "Claude is". */
  activity: string;
  /** Batches done out of total, or null before the first one lands. */
  progress: BatchProgress | null;
}

/**
 * The "Claude is working" strip shown while a batch run is in flight.
 *
 * Counts batches rather than showing an indeterminate spinner, because the runs
 * this covers take tens of seconds and a bar that never moves reads as a hang.
 */
export default function DraftingBanner({ activity, progress }: Props) {
  return (
    <div className="drafting-banner">
      <span className="chalk-spinner small" aria-hidden="true" />
      <span>
        Claude is {activity}
        {progress ? ` — batch ${progress.done} of ${progress.total}` : '…'}
      </span>
    </div>
  );
}
