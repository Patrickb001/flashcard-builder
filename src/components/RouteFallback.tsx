import { useEffect, useState } from 'react';

/**
 * What sits in the stage while a lazily-loaded screen is still being fetched.
 *
 * The wait is usually short and sometimes not short at all, and both cases go
 * wrong if you show the same thing immediately: a chunk that arrives in 40ms
 * flashes a spinner on and straight back off, while a chunk on a slow
 * connection leaves the screen blank long enough to read as a frozen app. So
 * nothing is drawn for the first fraction of a second, and after that the
 * spinner comes up and stays up.
 */
const QUIET_MS = 160;

interface Props {
  /** What the spinner announces to a screen reader once it appears. */
  label?: string;
}

/** Holds the fold with nothing, then a spinner once the wait is worth naming. */
export default function RouteFallback({ label = 'Loading…' }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), QUIET_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    // The live region is mounted for the whole wait, not just once the spinner
    // appears, so a screen reader announces the label when it is switched on
    // rather than missing a region that arrived already-populated.
    <div className="route-fallback" role="status" aria-live="polite">
      {visible && (
        <>
          <span className="chalk-spinner" aria-hidden="true" />
          <p className="muted small">{label}</p>
        </>
      )}
    </div>
  );
}
