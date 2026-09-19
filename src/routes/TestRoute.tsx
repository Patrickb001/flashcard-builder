import { useNavigate, useParams } from "react-router-dom";
import TestMode from "../components/TestMode";
import { canNavigateBack, currentHistoryIdx } from "../lib/navigationHistory";

/** Taking a test on one deck. */
export default function TestRoute() {
  const { deckId = "" } = useParams();
  const navigate = useNavigate();

  return (
    <TestMode
      deckId={deckId}
      onExit={() => navigate("/")}
      onStudy={(id) => navigate(`/deck/${id}/study`)}
      onManageExit={(id) =>
        // The only way into this screen is Manage cards' "Test this deck"
        // button, so any push at all (idx above 0, the tab's own first
        // entry) means that Manage entry is still there to pop back to — a
        // plain pop instead of a push, so it doesn't leave a second Manage
        // entry stacked behind this one. Falls back to a normal (replacing,
        // so it still doesn't stack) navigation for the one case that
        // isn't true: a direct load of this URL, with nothing of this
        // app's own before it to pop back to.
        canNavigateBack(0, currentHistoryIdx())
          ? navigate(-1)
          : navigate(`/deck/${id}`, { replace: true })
      }
    />
  );
}
