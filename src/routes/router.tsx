import { lazy } from 'react';
import { Navigate, createBrowserRouter } from 'react-router-dom';
import App from '../App';
import LibraryRoute from './LibraryRoute';

/**
 * Every screen but the landing one is fetched when first opened.
 *
 * Each wrapper imports its own screen, so loading a wrapper lazily loads the
 * screen behind it — and behind the uploader, the four document parsers and the
 * page fetcher, which are the bulk of the app's weight and are useless to
 * someone who only came back to study an existing deck.
 */
const UploadRoute = lazy(() => import('./UploadRoute'));
const ReviewRoute = lazy(() => import('./ReviewRoute'));
const DeckRoute = lazy(() => import('./DeckRoute'));
const StudyRoute = lazy(() => import('./StudyRoute'));
const TestRoute = lazy(() => import('./TestRoute'));

/**
 * The route table, as a data router.
 *
 * Nothing here needs the data APIs today — abandoning a test in progress is
 * guarded by a confirm() in QuizRunner, not by useBlocker — but createBrowserRouter
 * is the supported entry point and the only one those APIs are reachable from,
 * so there is no reason to start from the declarative router instead.
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
