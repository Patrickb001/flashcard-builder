import { useEffect, useMemo, useState } from 'react';
import type { Deck, Flashcard } from '../types';
import { getCardsForDeck, getDeck, updateCard } from '../db/db';
import { Diagram, Snippet } from './CardMedia';
import { shuffle } from '../lib/shuffle';

interface Props {
  deckId: string;
  onExit: () => void;
}

function tallyGroups(n: number): number[] {
  const groups: number[] = [];
  let remaining = n;
  while (remaining > 0) {
    groups.push(Math.min(5, remaining));
    remaining -= 5;
  }
  return groups;
}

function Tally({ count }: { count: number }) {
  if (count === 0) return <span className="tally-zero">—</span>;
  return (
    <span className="tally">
      {tallyGroups(count).map((g, gi) => (
        <span className="tally-group" key={gi}>
          {Array.from({ length: g }).map((_, i) => (
            <i key={i} className={`tally-stroke stroke-${i}`} />
          ))}
        </span>
      ))}
    </span>
  );
}

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
        const [d, c] = await Promise.all([getDeck(deckId), getCardsForDeck(deckId)]);
        setDeck(d ?? null);
        setCards(c);
        setOrder(c);
      } catch (err) {
        console.error('[study] Could not read the deck:', err);
        setError('This deck could not be read from the browser database.');
      } finally {
        // Cleared on both paths: clearing it only on success left this screen
        // on "Loading deck…" forever whenever IndexedDB was unavailable.
        setLoading(false);
      }
    })();
  }, [deckId]);

  const current = order[position];
  const finished = order.length > 0 && position >= order.length;
  const hasMedia = Boolean(current?.frontCode || current?.backCode || current?.image);

  const progressPct = useMemo(() => {
    if (order.length === 0) return 0;
    return Math.round((Math.min(position, order.length) / order.length) * 100);
  }, [position, order.length]);

  const mark = async (status: 'known' | 'unknown') => {
    if (!current) return;
    if (status === 'known') setKnown((k) => k + 1);
    else setUnknown((u) => u + 1);
    const updated: Flashcard = { ...current, status };
    try {
      await updateCard(updated);
    } catch (err) {
      // The card still advances: losing a status write is not worth
      // interrupting a study run over, but it should not be silent either.
      console.error('[study] Could not save the card status:', err);
      setError('Your progress on that card could not be saved.');
    }
    setCards((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    setFlipped(false);
    setPosition((p) => p + 1);
  };

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
            className={`flip-card ${flipped ? 'is-flipped' : ''} ${hasMedia ? 'has-media' : ''}`}
            onClick={() => setFlipped((f) => !f)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                setFlipped((f) => !f);
              }
            }}
          >
            <div className="flip-card-inner">
              <div className="flip-card-face flip-card-front">
                {current.context && <span className="topic-chip">{current.context}</span>}
                <span className="face-tag">Front</span>
                <div className="face-body">
                  <p>{current.front}</p>
                  {current.frontCode && <Snippet code={current.frontCode} />}
                </div>
                <span className="tap-hint">Click or press space to flip</span>
              </div>
              <div className="flip-card-face flip-card-back">
                {current.context && <span className="topic-chip">{current.context}</span>}
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
            <button className="secondary-btn learning" onClick={() => mark('unknown')}>
              Still learning
            </button>
            <button className="secondary-btn knew" onClick={() => mark('known')}>
              Knew it
            </button>
          </div>
        </>
      )}

      {finished && (
        <div className="study-summary">
          <h2>Deck complete</h2>
          <p className="muted">
            {known} knew it · {unknown} still learning, out of {order.length} cards.
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
