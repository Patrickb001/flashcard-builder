import { lazy } from 'react';
import { Navigate, createBrowserRouter } from 'react-router-dom';
import App from '../App';
import LibraryRoute from './LibraryRoute';

/**
 * Every screen but the landing one is fetched when first opened.
 *
 * The split moved from App to here unchanged. Each wrapper imports its own
 * screen, so loading a wrapper lazily loads the screen behind it — and behind
 * the uploader, the four document parsers and the page fetcher, which is most
 * of what the entry chunk used to carry.
 */
const UploadRoute = lazy(() => import('./UploadRoute'));
const ReviewRoute = lazy(() => import('./ReviewRoute'));
const DeckRoute = lazy(() => import('./DeckRoute'));
const StudyRoute = lazy(() => import('./StudyRoute'));
const TestRoute = lazy(() => import('./TestRoute'));

/**
 * A data router rather than <BrowserRouter>, deliberately.
 *
 * useBlocker — which is what asks before Back abandons a test in progress — is
 * not available with the declarative router. That one requirement decides the
 * shape of this file.
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <LibraryRoute /> },
      { path: 'upload', element: <UploadRoute /> },
      { path: 'review', element: <ReviewRoute /> },
      { path: 'deck/:deckId', element: <DeckRoute /> },
      { path: 'deck/:deckId/study', element: <StudyRoute /> },
      { path: 'deck/:deckId/test', element: <TestRoute /> },
      // An address that means nothing shows the library, and says so in the bar
      // rather than leaving a URL that never resolved.
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
