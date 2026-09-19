import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import StudyMode from '../components/StudyMode';
import { parseStudyMode } from '../lib/studyQueue';

/**
 * Studying one deck.
 *
 * The session mode lives in the address (`?mode=all`), like the library's open
 * folder, so reload and Back keep it. No param is a review session.
 */
export default function StudyRoute() {
  const { deckId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const mode = parseStudyMode(searchParams.get('mode'));

  return (
    <StudyMode
      deckId={deckId}
      mode={mode}
      onExit={() => navigate('/')}
      onChangeMode={(next) =>
        navigate(next === 'all' ? `/deck/${deckId}/study?mode=all` : `/deck/${deckId}/study`)
      }
    />
  );
}
