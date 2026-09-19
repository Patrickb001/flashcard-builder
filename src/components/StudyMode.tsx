import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reviewCard } from "../db/db";
import { describeDue, type Grade } from "../lib/scheduling";
import { shuffle } from "../lib/shuffle";
import {
  NEW_PER_SESSION,
  buildQueue,
  countStudyable,
  nextDueAt,
  requeue,
  type StudySessionMode,
} from "../lib/studyQueue";
import { Diagram, Snippet } from "./CardMedia";
import { useDeck } from "./useDeck";
import DeckGate from "./ui/DeckGate";
import ProgressBar from "./ui/ProgressBar";
import ScreenHeader from "./ui/ScreenHeader";
import Tally from "./ui/Tally";

interface Props {
  /** The deck to study. Its cards are read once, on mount. */
  deckId: string;
  /** Review (due + some new) or all cards. Comes from the URL; see StudyRoute. */
  mode: StudySessionMode;
  onExit: () => void;
  /** Switches mode by changing the URL, so Back returns to the previous one. */
  onChangeMode: (mode: StudySessionMode) => void;
}

/**
 * A study session: one card at a time, flipped by click or space, graded
 * "Knew it" (good) or "Still learning" (again).
 *
 * In review mode the session is what the schedule says is due, then up to
 * NEW_PER_SESSION new cards. In all mode it is the whole deck, for cramming.
 * Either way a grade goes through reviewCard, which applies countsAsReview —
 * so knowing a card early while cramming never inflates its interval, and
 * forgetting one always counts.
 *
 * A missed card comes back REQUEUE_GAP cards later, until it is known. Every
 * grade is written before the card advances, so a session interrupted halfway
 * keeps everything graded so far.
 */
export default function StudyMode({ deckId, mode, onExit, onChangeMode }: Props) {
  const { deck, cards, setCards, loading, error, setError } = useDeck(deckId);

  /**
   * The session, as card ids. Built once per session rather than derived from
   * `cards` on every render: grading updates `cards`, and rebuilding from that
   * would drop each card from the queue the moment it stopped being due.
   * Looked up by id at render, so a graded card is never shown stale.
   */
  const [queue, setQueue] = useState<string[] | null>(null);
  const [position, setPosition] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [saving, setSaving] = useState(false);
  const [known, setKnown] = useState(0);
  const [unknown, setUnknown] = useState(0);
  const [reviewed, setReviewed] = useState<Set<string>>(() => new Set());

  /** Latest cards for startSession, without making it rebuild on every grade. */
  const cardsRef = useRef(cards);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  /** Builds a fresh session from the cards as they are now. */
  const startSession = useCallback(
    (shuffleAll = false) => {
      const ids = buildQueue(cardsRef.current, mode, Date.now());
      setQueue(mode === "all" && shuffleAll ? shuffle(ids) : ids);
      setPosition(0);
      setFlipped(false);
      setKnown(0);
      setUnknown(0);
      setReviewed(new Set());
    },
    [mode],
  );

  // Declared after the ref effect above, so the ref holds the loaded cards by
  // the time this runs in the same commit.
  useEffect(() => {
    if (!loading) startSession();
  }, [loading, startSession]);

  const cardsById = useMemo(
    () => new Map(cards.map((card) => [card.id, card])),
    [cards],
  );

  /** Same height for every card in a deck with any media; see the CSS. */
  const deckHasMedia = useMemo(
    () => cards.some((card) => card.frontCode || card.backCode || card.image),
    [cards],
  );

  const current = queue ? cardsById.get(queue[position]) : undefined;
  const finished = queue !== null && position >= queue.length;

  /** Records a grade, saves it, requeues a miss, and moves to the next card. */
  const mark = async (grade: Grade) => {
    if (!current || !queue || saving) return;
    const graded = current;
    const at = position;
    setSaving(true);
    if (grade === "again") setUnknown((u) => u + 1);
    else setKnown((k) => k + 1);
    setReviewed((prev) => new Set(prev).add(graded.id));

    try {
      const stored = await reviewCard(graded.id, grade, Date.now());
      if (stored) {
        setCards((prev) => prev.map((card) => (card.id === stored.id ? stored : card)));
      }
    } catch (err) {
      // The card still advances: losing one grade is not worth stopping a
      // session over, but it should not be silent either.
      console.error("[study] Could not save the grade:", err);
      setError("Your progress on that card could not be saved.");
    }

    if (grade === "again") setQueue((q) => (q ? requeue(q, at, graded.id) : q));
    setFlipped(false);
    setPosition((p) => p + 1);
    setSaving(false);
  };

  if (loading || !deck) {
    return <DeckGate loading={loading} error={error} deck={deck} />;
  }
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
  if (queue === null) return null;

  const now = Date.now();
  const remaining = countStudyable(cards, now);
  const nextDue = nextDueAt(cards, now);
  const nextDueLine =
    nextDue === null ? null : `Next review ${describeDue(nextDue, now)}.`;

  // Nothing due and nothing new: say so, rather than showing an empty session.
  if (queue.length === 0) {
    return (
      <div className="study">
        <ScreenHeader eyebrow="Review" title={deck.name} />
        <div className="study-summary">
          <h2>All caught up</h2>
          <p className="muted">
            Nothing in this deck is due today.{nextDueLine ? ` ${nextDueLine}` : ""}
          </p>
          <div className="form-actions">
            <button className="ghost-btn" onClick={onExit}>
              Back to library
            </button>
            <button className="secondary-btn" onClick={() => onChangeMode("all")}>
              Study all cards anyway
            </button>
          </div>
        </div>
      </div>
    );
  }

  const progressFraction = Math.min(position, queue.length) / queue.length;
  const moreToStudy = remaining.due + remaining.new;

  return (
    <div className="study">
      <ScreenHeader
        eyebrow={mode === "all" ? "Studying all cards" : "Review"}
        title={deck.name}
      >
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
      </ScreenHeader>

      <ProgressBar fraction={progressFraction} />

      {!finished && current && (
        <>
          <p className="muted small centered">
            Card {position + 1} of {queue.length} · {current.sourceLabel}
          </p>

          <div
            key={`${current.id}-${position}`}
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
              disabled={saving}
              onClick={() => mark("again")}
            >
              Still learning
            </button>
            <button
              className="secondary-btn knew"
              disabled={saving}
              onClick={() => mark("good")}
            >
              Knew it
            </button>
          </div>
        </>
      )}

      {finished && mode === "review" && (
        <div className="study-summary">
          <h2>Session complete</h2>
          <p className="muted">
            {reviewed.size} card{reviewed.size === 1 ? "" : "s"} reviewed
            {unknown > 0 ? ` · ${unknown} miss${unknown === 1 ? "" : "es"} retried` : ""}.
            {nextDueLine ? ` ${nextDueLine}` : ""}
          </p>
          <div className="form-actions">
            <button className="ghost-btn" onClick={onExit}>
              Back to library
            </button>
            {moreToStudy > 0 && (
              <button className="primary-btn" onClick={() => startSession()}>
                {remaining.due > 0
                  ? "Keep going"
                  : `Learn ${Math.min(remaining.new, NEW_PER_SESSION)} more new cards`}
              </button>
            )}
          </div>
        </div>
      )}

      {finished && mode === "all" && (
        <div className="study-summary">
          <h2>Deck complete</h2>
          <p className="muted">
            {known} knew it · {unknown} still learning, over {reviewed.size} cards.
            Cards you knew before they were due keep their schedule.
          </p>
          <div className="form-actions">
            <button className="ghost-btn" onClick={onExit}>
              Back to library
            </button>
            <button className="secondary-btn" onClick={() => startSession(false)}>
              Study again
            </button>
            <button className="primary-btn" onClick={() => startSession(true)}>
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
          {mode === "all" && (
            <button className="ghost-btn" onClick={() => startSession(true)}>
              Shuffle deck
            </button>
          )}
        </div>
      )}
    </div>
  );
}
