import type { Flashcard, TestQuestion } from '../../types';
import type { PreparedQuestion } from '../../lib/quizSelection';
import { Diagram, Snippet } from '../CardMedia';

/**
 * One question at a time.
 *
 * Nothing here reaches the network or the database: the pool was written once
 * and kept, and grading is a comparison against the stored answer. That is the
 * whole reason a test works offline.
 */
interface Props {
  asked: PreparedQuestion[];
  position: number;
  selected: number | null;
  onSelect: (index: number) => void;
  onCommit: () => void;
  cardFor: (question: TestQuestion) => Flashcard | undefined;
  onExit: () => void;
}

export default function QuizRunner({
  asked,
  position,
  selected,
  onSelect,
  onCommit,
  cardFor,
  onExit,
}: Props) {
  const current = asked[position];
  const card = cardFor(current.question);
  const pct = Math.round((position / asked.length) * 100);
  const last = position + 1 >= asked.length;

  return (
    <div className="quiz">
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>

      <p className="muted small centered">
        Question {position + 1} of {asked.length} · {current.question.sourceLabel}
      </p>

      <div className="quiz-question">
        {current.question.context && <span className="topic-chip">{current.question.context}</span>}
        {/* Board-style items open with a scenario; recall questions have none,
            and so does a board item whose card could not carry one. */}
        {current.question.vignette && (
          <p className="quiz-vignette">{current.question.vignette}</p>
        )}
        <p className="quiz-stem">{current.question.stem}</p>
        {current.question.stemCode && <Snippet code={current.question.stemCode} />}
        {current.question.stemImage && <Diagram image={current.question.stemImage} />}
        {!current.question.stemCode && card?.frontCode && <Snippet code={card.frontCode} />}
      </div>

      <ul className="quiz-options" role="radiogroup" aria-label="Answer options">
        {current.options.map((option, i) => (
          <li key={i}>
            <button
              type="button"
              role="radio"
              aria-checked={selected === i}
              className={`quiz-option ${selected === i ? 'selected' : ''}`}
              onClick={() => onSelect(i)}
            >
              <span className="quiz-option-key">{String.fromCharCode(65 + i)}</span>
              <span>{option}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="form-actions">
        <button
          className="ghost-btn"
          onClick={() => {
            if (confirm('End this test? Your answers so far will not be scored.')) onExit();
          }}
        >
          Exit test
        </button>
        <button className="primary-btn" onClick={onCommit} disabled={selected === null}>
          {last ? 'Finish test' : 'Next question'}
        </button>
      </div>
    </div>
  );
}
