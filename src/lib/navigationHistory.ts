/**
 * Whether the app has an in-app page to go back to.
 *
 * `currentIdx` is the browser history index right now; `mountIdx` is what
 * that index was the moment this page instance first loaded. A fresh page
 * load or reload always starts even with its own mount point — even though
 * the browser's own history index can be high from earlier in the session —
 * so Back only offers to go somewhere this instance actually knows about.
 */
export function canNavigateBack(mountIdx: number, currentIdx: number): boolean {
  return currentIdx > mountIdx;
}

/**
 * The browser's own history-entry index for right now, or 0 if
 * react-router-dom's history hasn't set one yet (there is always one once
 * the router has rendered once, but this keeps the read total).
 */
export function currentHistoryIdx(): number {
  const state = window.history.state as { idx?: number } | null;
  return state?.idx ?? 0;
}
