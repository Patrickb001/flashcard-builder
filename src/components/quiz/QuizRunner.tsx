import type { Flashcard, TestQuestion } from '../../types';
import type { PreparedQuestion } from '../../lib/quizSelection';
import ProgressBar from '../ui/ProgressBar';
import QuestionStem from './QuestionStem';

interface Props {
  /** Every question in this test, in the order it will be asked. */
  asked: PreparedQuestion[];
  /** Index into `asked` of the question on screen. */
  position: number;
  /** The option the user has picked but not yet committed, or null. */
  selected: number | null;
  onSelect: (index: number) => void;
  /** Locks the current answer in and advances. The caller records it. */
  onCommit: () => void;
  /**
   * The card a question was written from, for the snippet a stem may need.
   * Passed in rather than looked up here, because the deck's cards belong to
   * the hook that loaded them.
   */
  cardFor: (question: TestQuestion) => Flashcard | undefined;
  onExit: () => void;
}

/**
 * One question at a time, with its options.
 *
 * Reaches nothing itself: the pool was written once and kept, and grading is a
 * comparison against the stored answer, which is why a test runs offline. The
 * one write a test makes is `onCommit`'s, recorded by the caller.
 */
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
  const last = position + 1 >= asked.length;

  return (
    <div className="quiz">
      <ProgressBar fraction={position / asked.length} />

      <p className="muted small centered">
        Question {position + 1} of {asked.length} · {current.question.sourceLabel}
      </p>

      <div className="quiz-question">
        {current.question.context && <span className="topic-chip">{current.question.context}</span>}
        <QuestionStem question={current.question} fallbackCode={card?.frontCode} />
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
