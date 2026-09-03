import { useEffect, useMemo, useState } from "react";
import type { Deck, Flashcard } from "../types";
import { getCardsForDeck, getDeck, updateCard } from "../db/db";
import { Diagram, Snippet } from "./CardMedia";
import { shuffle } from "../lib/shuffle";

interface Props {
  /** The deck to study. Its cards are read once, on mount. */
  deckId: string;
  onExit: () => void;
}

/** Splits a count into groups of five, the way tally marks are gated. */
function tallyGroups(n: number): number[] {
  const groups: number[] = [];
  let remaining = n;
  while (remaining > 0) {
    groups.push(Math.min(5, remaining));
    remaining -= 5;
  }
  return groups;
}

/** A running count drawn as chalk tally marks, five to a gate. */
function Tally({ count }: { count: number }) {
  if (count === 0) return <span className="tally-zero">—</span>;
  return (
    <span className="tally">
      {tallyGroups(count).map((groupSize, groupIndex) => (
        <span className="tally-group" key={groupIndex}>
          {Array.from({ length: groupSize }).map((_, i) => (
            <i key={i} className={`tally-stroke stroke-${i}`} />
          ))}
        </span>
      ))}
    </span>
  );
}

/**
 * A study run: one card at a time, flipped by click or space, marked known or
 * still-learning.
 *
 * Marking a card writes its status straight to the database and advances, so a
 * run interrupted halfway is not lost. A failed write is reported but does not
 * stop the run — losing one card's status is not worth interrupting studying.
 */
export default function StudyMode({ deckId, onExit }: Props) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [order, setOrder] = useState<Flashcard[]>([]);
  const [position, setPosition] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [known, setKnown] = useState(0);
  const [unknown, setUnknown] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [loadedDeck, loadedCards] = await Promise.all([
          getDeck(deckId),
          getCardsForDeck(deckId),
        ]);
        setDeck(loadedDeck ?? null);
        setCards(loadedCards);
        setOrder(loadedCards);
      } catch (err) {
        console.error("[study] Could not read the deck:", err);
        setError("This deck could not be read from the browser database.");
      } finally {
        // Cleared on both paths: clearing it only on success left this screen
        // on "Loading deck…" forever whenever IndexedDB was unavailable.
        setLoading(false);
      }
    })();
  }, [deckId]);

  const current = order[position];
  const finished = order.length > 0 && position >= order.length;

  /**
   * Whether ANY card in this deck carries a snippet or a diagram — not whether
   * the card on screen does.
   *
   * The card's height follows from this, so every card in a deck is the same
   * size and moving through them doesn't resize the box under the cursor. Asked
   * per card instead, the deck jumped between two heights as you went.
   *
   * A deck with no media anywhere still gets the compact card: there is nothing
   * for the extra room to hold, and nothing to be consistent with.
   */
  const deckHasMedia = useMemo(
    () => cards.some((card) => card.frontCode || card.backCode || card.image),
    [cards],
  );

  const progressPct = useMemo(() => {
    if (order.length === 0) return 0;
    return Math.round((Math.min(position, order.length) / order.length) * 100);
  }, [position, order.length]);

  /** Records how the current card went, saves it, and moves to the next. */
  const mark = async (status: "known" | "unknown") => {
    if (!current) return;
    if (status === "known") setKnown((k) => k + 1);
    else setUnknown((u) => u + 1);
    const updated: Flashcard = { ...current, status };
    try {
      await updateCard(updated);
    } catch (err) {
      // The card still advances: losing a status write is not worth
      // interrupting a study run over, but it should not be silent either.
      console.error("[study] Could not save the card status:", err);
      setError("Your progress on that card could not be saved.");
    }
    setCards((prev) => prev.map((card) => (card.id === updated.id ? updated : card)));
    setFlipped(false);
    setPosition((p) => p + 1);
  };

  /** Starts the deck again, in document order or shuffled. */
  const restart = (shuffled: boolean) => {
    setOrder(shuffled ? shuffle(cards) : cards);
    setPosition(0);
    setFlipped(false);
    setKnown(0);
    setUnknown(0);
  };

  if (loading) return <p className="muted">Loading deck…</p>;
  if (error && !deck)
    return (
      <div className="ai-notice failed">
        <strong>This deck could not be opened</strong>
        <p>{error}</p>
      </div>
    );
  if (!deck) return <p className="muted">This deck couldn't be found.</p>;
  if (cards.length === 0) {
    return (
      <div className="study-empty">
        <p className="muted">This deck has no cards yet.</p>
        <button className="ghost-btn" onClick={onExit}>
          Back to library
        </button>
      </div>
    );
  }

  return (
    <div className="study">
      <div className="study-header">
        <div>
          <p className="eyebrow">Studying</p>
          <h1>{deck.name}</h1>
        </div>
        <div className="tally-board">
          <div className="tally-row">
            <span className="tally-label knew">Knew it</span>
            <Tally count={known} />
          </div>
          <div className="tally-row">
            <span className="tally-label learning">Still learning</span>
            <Tally count={unknown} />
          </div>
        </div>
      </div>

      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${progressPct}%` }} />
      </div>

      {!finished && current && (
        <>
          <p className="muted small centered">
            Card {position + 1} of {order.length} · {current.sourceLabel}
          </p>

          <div
            className={`flip-card ${flipped ? "is-flipped" : ""} ${
              deckHasMedia ? "deck-has-media" : ""
            }`}
            onClick={() => setFlipped((f) => !f)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                setFlipped((f) => !f);
              }
            }}
          >
            <div className="flip-card-inner">
              <div className="flip-card-face flip-card-front">
                {current.context && (
                  <span className="topic-chip">{current.context}</span>
                )}
                <span className="face-tag">Front</span>
                <div className="face-body">
                  <p>{current.front}</p>
                  {current.frontCode && <Snippet code={current.frontCode} />}
                </div>
                <span className="tap-hint">Click or press space to flip</span>
              </div>
              <div className="flip-card-face flip-card-back">
                {current.context && (
                  <span className="topic-chip">{current.context}</span>
                )}
                <span className="face-tag">Back</span>
                <div className="face-body">
                  <p>{current.back}</p>
                  {current.backCode && <Snippet code={current.backCode} />}
                  {current.image && <Diagram image={current.image} />}
                </div>
              </div>
            </div>
          </div>

          <div className="study-actions">
            <button
              className="secondary-btn learning"
              onClick={() => mark("unknown")}
            >
              Still learning
            </button>
            <button
              className="secondary-btn knew"
              onClick={() => mark("known")}
            >
              Knew it
            </button>
          </div>
        </>
      )}

      {finished && (
        <div className="study-summary">
          <h2>Deck complete</h2>
          <p className="muted">
            {known} knew it · {unknown} still learning, out of {order.length}{" "}
            cards.
          </p>
          <div className="form-actions">
            <button className="ghost-btn" onClick={onExit}>
              Back to library
            </button>
            <button className="secondary-btn" onClick={() => restart(false)}>
              Study again
            </button>
            <button className="primary-btn" onClick={() => restart(true)}>
              Shuffle &amp; restart
            </button>
          </div>
        </div>
      )}

      {!finished && (
        <div className="form-actions">
          <button className="ghost-btn" onClick={onExit}>
            Exit to library
          </button>
          <button className="ghost-btn" onClick={() => restart(true)}>
            Shuffle deck
          </button>
        </div>
      )}
    </div>
  );
}
