import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches a render-time throw and shows it, instead of a blank page.
 *
 * Without one of these anywhere in the tree, React unmounts the whole app on an
 * uncaught render error and leaves an empty document behind — which looks
 * exactly like a failed deploy, with the real cause visible only in DevTools.
 *
 * Deliberately a class: componentDidCatch has no hook equivalent, and this is
 * the only class component in the app for that reason.
 */

interface Props {
  /** The tree to guard. Everything below it is replaced on a throw. */
  children: ReactNode;
}

interface State {
  /** The error caught, or null while the tree is rendering normally. */
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The component stack says which screen died, which the message alone does
    // not, so it goes to the console even though the banner shows the message.
    console.error('[ui] Unhandled render error:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="app-shell">
        <main className="stage">
          <div className="ai-notice failed">
            <strong>Something broke</strong>
            <p>
              The screen you were on stopped working. Your decks are stored in this browser and are
              not affected.
            </p>
            <p className="muted small">{error.message}</p>
            <div>
              <button className="primary-btn" onClick={() => window.location.reload()}>
                Reload the app
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }
}
