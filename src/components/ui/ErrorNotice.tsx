interface Props {
  /**
   * The heading above the message. Omitted for an inline notice sitting inside
   * a screen that is otherwise working.
   */
  title?: string;
  /** What went wrong, written for the reader rather than for a log. */
  message: string;
}

/**
 * A failure the reader needs to see, in the app's one notice style.
 *
 * Used both for a screen that could not load at all and for a smaller problem
 * on a screen that is otherwise fine — the difference is whether a title is
 * given, not a different component.
 */
export default function ErrorNotice({ title, message }: Props) {
  return (
    <div className="ai-notice failed" role="alert">
      {title && <strong>{title}</strong>}
      <p>{message}</p>
    </div>
  );
}
