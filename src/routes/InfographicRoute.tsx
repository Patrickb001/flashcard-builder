import { useParams } from "react-router-dom";
import InfographicMode from "../components/InfographicMode";

/** A deck's saved infographics, and creating new ones. */
export default function InfographicRoute() {
  const { deckId = "" } = useParams();

  return <InfographicMode deckId={deckId} />;
}
