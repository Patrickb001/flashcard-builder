import { Suspense } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import RouteFallback from './components/RouteFallback';

/**
 * The frame every screen sits in: the masthead, and the routed slot below it.
 *
 * Holds no screen state of its own. Each screen is a route rendered into the
 * `<Outlet>`, so the address bar always names what is on the glass.
 */
export default function App() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const atLibrary = pathname === '/';

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
        {/*
          Keyed on the address, and that key is the whole point. React Router
          runs navigations inside a transition, so without it React holds the
          screen you are leaving on the glass while the next chunk downloads,
          and the app looks like it ignored the click. A boundary with a new key
          is new content rather than a stale update, so the fallback is allowed
          to show. The key also restarts the fade, so every screen arrives alike.
        */}
        <Suspense key={pathname} fallback={<RouteFallback />}>
          <div className="stage-screen">
            <Outlet />
          </div>
        </Suspense>
      </main>
    </div>
  );
}
