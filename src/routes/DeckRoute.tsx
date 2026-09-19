import { useNavigate, useParams } from "react-router-dom";
import DeckManager from "../components/DeckManager";

/** Managing one deck's cards. */
export default function DeckRoute() {
  const { deckId = "" } = useParams();
  const navigate = useNavigate();

  return (
    <DeckManager
      deckId={deckId}
      onStudy={(id) => navigate(`/deck/${id}/study`)}
      onStudyAll={(id) => navigate(`/deck/${id}/study?mode=all`)}
      onTest={(id) => navigate(`/deck/${id}/test`)}
      onInfographic={(id) => navigate(`/deck/${id}/infographic`)}
      // Replace: the deck is gone, so Back must not return to its page.
      onDeckDeleted={() => navigate("/", { replace: true })}
    />
  );
}
