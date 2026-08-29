import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import CandidateReview from '../components/CandidateReview';
import { draftFromState } from './reviewDraft';

/**
 * Reviewing the drafted cards before they become a deck.
 *
 * Reached with a draft in history state. Arriving without one means the state
 * was lost — a reload, or someone opening /review directly — and there is
 * nothing to review, so this sends them back to pick a document.
 */
export default function ReviewRoute() {
  const navigate = useNavigate();
  const draft = draftFromState(useLocation().state);

  if (!draft) return <Navigate to="/upload" replace />;

  return (
    <CandidateReview
      sections={draft.sections}
      fileName={draft.fileName}
      sourceType={draft.sourceType}
      ai={draft.ai}
      notice={draft.notice}
      // Replace, so Back from the new deck does not return to a review screen
      // whose cards have already been saved.
      onSaved={(deckId) => navigate(`/deck/${deckId}`, { replace: true })}
      onCancel={() => navigate('/')}
    />
  );
}
