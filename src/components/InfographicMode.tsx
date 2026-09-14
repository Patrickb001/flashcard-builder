import { useEffect, useState } from "react";
import type { AiSettings } from "../lib/aiGenerator";
import { loadAiSettings } from "../lib/aiGenerator";
import { deleteInfographic, getInfographicsForDeck, saveInfographic } from "../db/db";
import { generateInfographic } from "../lib/infographicGenerator";
import type { Flashcard, Infographic, InfographicDetail } from "../types";
import { useDeck } from "./useDeck";
import DeckGate from "./ui/DeckGate";
import ErrorNotice from "./ui/ErrorNotice";
import InfographicList from "./infographic/InfographicList";
import InfographicSetup from "./infographic/InfographicSetup";
import InfographicView from "./infographic/InfographicView";

interface Props {
  deckId: string;
}

type Phase = "list" | "setup" | "generating" | "view" | "error";

/**
 * The infographic feature's phase owner, mirroring TestMode's role: this
 * component decides which screen is showing, the screens themselves are
 * dumb and just call back up.
 *
 * List/Setup/Generating/View/Error are all component state, not separate
 * routes — moving between them never calls navigate(). Entering from Deck
 * Manager is the one real navigation this feature has.
 */
export default function InfographicMode({ deckId }: Props) {
  const { deck, cards, loading, error } = useDeck(deckId);
  const [infographics, setInfographics] = useState<Infographic[]>([]);
  const [infographicsLoaded, setInfographicsLoaded] = useState(false);
  const [phase, setPhase] = useState<Phase>("list");
  const [viewing, setViewing] = useState<Infographic | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [ai, setAi] = useState<AiSettings>(() => loadAiSettings());

  useEffect(() => {
    let cancelled = false;
    getInfographicsForDeck(deckId)
      .then((list) => {
        if (cancelled) return;
        setInfographics(list);
        setPhase(list.length > 0 ? "list" : "setup");
        setInfographicsLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        // Without this catch, a rejected read (a storage error, another tab
        // holding a blocked v3->v4 upgrade open) left this screen on
        // "Loading infographics..." forever with nothing in view and no way
        // forward — the same failure useDeckQuiz.ts already guards against
        // on its own mount read.
        console.error("[infographic] Could not read saved infographics:", err);
        setGenerationError("Your saved infographics could not be read from the browser database.");
        setInfographicsLoaded(true);
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, [deckId]);

  const refreshList = async () => {
    setInfographics(await getInfographicsForDeck(deckId));
  };

  const handleGenerate = async (detail: InfographicDetail, chosenCards: Flashcard[]) => {
    setPhase("generating");
    try {
      const infographic = await generateInfographic(deckId, deck!.name, chosenCards, detail, ai);
      await saveInfographic(infographic);
      await refreshList();
      setViewing(infographic);
      setPhase("view");
    } catch (err) {
      console.error("[infographic] Could not generate the infographic:", err);
      // The thrown error's own message names the actual cause (no API key,
      // the dev server not running, a reply cut off mid-JSON, the payload
      // too large) — discarding it in favour of one generic line left every
      // failure mode looking identical and equally unactionable.
      setGenerationError(
        `The infographic could not be generated. ${err instanceof Error ? err.message : ""}`.trim()
      );
      setPhase("error");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteInfographic(id);
      await refreshList();
      setViewing(null);
      setPhase("list");
    } catch (err) {
      console.error("[infographic] Could not delete the infographic:", err);
      setGenerationError("This infographic could not be deleted. Try again.");
      setPhase("error");
    }
  };

  if (loading || !deck) return <DeckGate loading={loading} error={error} deck={deck} />;
  if (!infographicsLoaded) return <p className="muted">Loading infographics…</p>;

  if (phase === "list") {
    return (
      <InfographicList
        infographics={infographics}
        onView={(infographic) => {
          setViewing(infographic);
          setPhase("view");
        }}
        onDelete={handleDelete}
        onCreate={() => setPhase("setup")}
      />
    );
  }

  if (phase === "setup") {
    return (
      <InfographicSetup
        deckName={deck.name}
        cards={cards}
        ai={ai}
        onAiChange={setAi}
        onGenerate={handleGenerate}
        onBack={infographics.length > 0 ? () => setPhase("list") : undefined}
      />
    );
  }

  if (phase === "generating") {
    return (
      <div className="infographic-generating">
        <span className="chalk-spinner" aria-hidden="true" />
        <p className="muted small">Writing the infographic…</p>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div>
        <ErrorNotice message={generationError ?? "Something went wrong."} />
        <div className="form-actions">
          <button type="button" className="secondary-btn" onClick={() => setPhase("setup")}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  // phase === "view"
  return (
    <InfographicView
      infographic={viewing!}
      totalCardCount={cards.length}
      onBack={() => setPhase("list")}
      onDelete={() => handleDelete(viewing!.id)}
    />
  );
}
