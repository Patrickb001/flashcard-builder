/**
 * Driving a sequence of model requests.
 *
 * Card drafting and question writing both send work to the model in batches,
 * and both had written out the same loop: step through the batches, stop if the
 * user cancelled, count the failures, remember the first error, report progress.
 * Only the body of the loop actually differed.
 */

/** How far through a run we are. Shared: the two features report it the same way. */
export interface BatchProgress {
  done: number;
  total: number;
}

export interface BatchRun<T> {
  failedBatches: number;
  /** The first failure's message, for showing the user one cause rather than ten. */
  firstError: string | null;
  /** True when the run stopped early because it was cancelled. */
  aborted: boolean;
  /** Batches never attempted, because the run was cancelled before reaching them. */
  remaining: T[];
}

export interface BatchOptions<T> {
  signal?: AbortSignal;
  onProgress?: (p: BatchProgress) => void;
  /**
   * Added to the reported counts.
   *
   * A retry pass continues the first pass's numbering rather than restarting
   * it, so the progress bar does not jump backwards.
   */
  progressOffset?: BatchProgress;
  /** Called where a batch failed, so a caller can substitute something for it. */
  onFailure?: (batch: T, error: unknown) => void;
}

/** True for the rejection a fetch produces when its signal is aborted. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Runs each batch in turn, and reports what happened.
 *
 * `run` throwing means that batch produced nothing; it is counted, `onFailure`
 * is given the chance to substitute something, and the run continues. Anything
 * a batch *partly* achieved is the caller's to record inside `run`.
 *
 * Cancellation is separated from failure and reported as its own outcome. Left
 * to the generic catch, pressing Stop reads back to the user as an error.
 */
export async function runBatches<T>(
  batches: T[],
  run: (batch: T) => Promise<void>,
  options: BatchOptions<T> = {}
): Promise<BatchRun<T>> {
  const offset = options.progressOffset ?? { done: 0, total: 0 };
  const total = offset.total + batches.length;

  let failedBatches = 0;
  let firstError: string | null = null;

  for (let i = 0; i < batches.length; i++) {
    if (options.signal?.aborted) {
      return { failedBatches, firstError, aborted: true, remaining: batches.slice(i) };
    }

    try {
      await run(batches[i]);
    } catch (err) {
      if (isAbort(err) || options.signal?.aborted) {
        return { failedBatches, firstError, aborted: true, remaining: batches.slice(i) };
      }
      failedBatches += 1;
      if (!firstError) firstError = err instanceof Error ? err.message : String(err);
      options.onFailure?.(batches[i], err);
    }

    options.onProgress?.({ done: offset.done + i + 1, total });
  }

  return { failedBatches, firstError, aborted: false, remaining: [] };
}
