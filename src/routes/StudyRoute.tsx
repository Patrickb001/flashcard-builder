import { useNavigate, useParams } from 'react-router-dom';
import StudyMode from '../components/StudyMode';

/** Studying one deck. */
export default function StudyRoute() {
  const { deckId = '' } = useParams();
  const navigate = useNavigate();

  return <StudyMode deckId={deckId} onExit={() => navigate('/')} />;
}
