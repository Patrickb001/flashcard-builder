import { Suspense } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

/**
 * The frame every screen sits in: the masthead, and the slot below it.
 *
 * This used to hold the current screen in a `view` union and swap it with
 * setState, which is why the address bar read "/" whatever you were looking at.
 * The screens are routes now; all that is left here is the chrome around them.
 */
export default function App() {
  const navigate = useNavigate();
  const atLibrary = useLocation().pathname === '/';

  return (
    <div className="app-shell">
      <header className="top-bar">
        <button className="brand" onClick={() => navigate('/')}>
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 40 40" width="28" height="28">
              <line x1="10" y1="8" x2="10" y2="32" />
              <line x1="16" y1="8" x2="16" y2="32" />
              <line x1="22" y1="8" x2="22" y2="32" />
              <line x1="28" y1="8" x2="28" y2="32" />
              <line x1="7" y1="28" x2="31" y2="10" />
            </svg>
          </span>
          <span className="brand-text">
            Flashcard <em>Forge</em>
          </span>
        </button>
        {!atLibrary && (
          <button className="ghost-btn" onClick={() => navigate('/')}>
            ← Back to library
          </button>
        )}
      </header>

      <main className="stage">
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
