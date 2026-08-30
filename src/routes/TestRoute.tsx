import { useNavigate, useParams } from 'react-router-dom';
import TestMode from '../components/TestMode';

/** Taking a test on one deck. */
export default function TestRoute() {
  const { deckId = '' } = useParams();
  const navigate = useNavigate();

  return <TestMode deckId={deckId} onExit={() => navigate('/')} />;
}
