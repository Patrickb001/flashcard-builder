import { Suspense, useRef } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import RouteFallback from './components/RouteFallback';
import ThemeToggle from './components/ui/ThemeToggle';
import { canNavigateBack, currentHistoryIdx } from './lib/navigationHistory';

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
  // The history index as of this page load. A fresh load or reload always
  // starts even with its own baseline, so Back only offers a page this
  // instance actually navigated to itself — see the design doc's
  // Decisions table and Mechanism section for why this can't just read
  // the browser's raw index on its own.
  const mountIdxRef = useRef(currentHistoryIdx());
  const canGoBack = canNavigateBack(mountIdxRef.current, currentHistoryIdx());

  return (
    <div className="app-shell">
      <header className="top-bar">
        <button className="brand" onClick={() => navigate('/')}>
          <span className="brand-mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="7" width="14" height="10" rx="2" />
              <path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h9A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H17" />
            </svg>
          </span>
          <span className="brand-text">Flashcard Forge</span>
        </button>
        <div className="top-bar-actions">
          {!atLibrary && canGoBack && (
            <button className="ghost-btn" onClick={() => navigate(-1)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 6l-6 6 6 6" />
              </svg>
              Back
            </button>
          )}
          <ThemeToggle />
        </div>
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
