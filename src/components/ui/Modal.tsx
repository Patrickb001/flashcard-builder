import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  /** Mounted only while true, so a stale name or half-typed draft never flashes on reopen. */
  open: boolean;
  /** Fired by Escape, a click on the scrim, and the corner close button alike. */
  onClose: () => void;
  /** Id of the heading inside, wired to aria-labelledby. */
  labelledBy: string;
  /** Tints the leading icon, for a dialog that asks about a destructive action. */
  danger?: boolean;
  children: React.ReactNode;
}

/**
 * The app's one dialog chrome: a scrim behind a centred card, portalled to
 * `document.body` so it always sits above the screen underneath it.
 *
 * Owns focus (sent inside on open, returned to what opened it on close) and
 * Escape, so every dialog gets those for free rather than each screen wiring
 * them up its own way.
 */
export default function Modal({ open, onClose, labelledBy, danger, children }: Props) {
  const [entered, setEntered] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    // A frame late, so the scrim mounts at opacity 0 before transitioning to
    // .open — added on mount, the transition would have nothing to animate from.
    const enterFrame = requestAnimationFrame(() => setEntered(true));
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusFrame = requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>('input, button:not(.icon-btn)')?.focus();
    });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(enterFrame);
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className={`scrim${entered ? ' open' : ''}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`dialog${danger ? ' danger' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
