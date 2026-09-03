import type { Flashcard, TestQuestion } from '../../types';
import type { PreparedQuestion } from '../../lib/quizSelection';
import { Diagram, Snippet } from '../CardMedia';

/**
 * The score, and a review of every question asked.
 *
 * Both halves are shown: what was missed, and what was answered correctly. The
 * questions stay in the order they were asked and each row says which it was,
 * so the review reads as a record of the whole test rather than a list of
 * failures. The explanation is written to teach the distinction rather than to
 * restate the answer, which is worth reading on a lucky guess too.
 */
interface Props {
  asked: PreparedQuestion[];
  answers: (number | null)[];
  cardFor: (question: TestQuestion) => Flashcard | undefined;
  onAgain: () => void;
  onExit: () => void;
}

export default function QuizResults({ asked, answers, cardFor, onAgain, onExit }: Props) {
  const correctCount = asked.reduce((n, q, i) => n + (answers[i] === q.correctIndex ? 1 : 0), 0);
  const pct = asked.length === 0 ? 0 : Math.round((correctCount / asked.length) * 100);
  const missedCount = asked.length - correctCount;

  return (
    <div className="quiz">
      <div className="study-summary">
        <h2 className="quiz-score">
          {correctCount} of {asked.length}
        </h2>
        <p className="muted">{pct}% correct</p>
      </div>

      {asked.length > 0 && (
        <>
          <p className="eyebrow">
            Review — {missedCount} missed · {correctCount} correct
          </p>
          {missedCount === 0 && <p className="muted centered">Clean sheet — every answer correct.</p>}

          <ul className="quiz-review">
            {asked.map((prepared, index) => {
              const picked = answers[index];
              const wasCorrect = picked === prepared.correctIndex;
              const card = cardFor(prepared.question);
              return (
                <li
                  className={`quiz-review-row ${wasCorrect ? 'correct' : 'missed'}`}
                  key={prepared.question.id}
                >
                  <p className={`quiz-verdict ${wasCorrect ? 'correct' : 'missed'}`}>
                    <span aria-hidden="true">{wasCorrect ? '✓' : '✕'}</span>
                    {wasCorrect ? 'Correct' : 'Missed'}
                  </p>

                  {prepared.question.vignette && (
                    <p className="quiz-vignette">{prepared.question.vignette}</p>
                  )}
                  <p className="quiz-stem">{prepared.question.stem}</p>
                  {prepared.question.stemCode && <Snippet code={prepared.question.stemCode} />}
                  {prepared.question.stemImage && <Diagram image={prepared.question.stemImage} />}

                  <p className={`quiz-answer-line ${wasCorrect ? 'correct' : 'picked'}`}>
                    <span className="quiz-answer-tag">You chose</span>
                    {picked === null ? 'nothing' : prepared.options[picked]}
                  </p>
                  {/* Only worth a second line when it differs from the first —
                      repeating a right answer back reads as a correction. */}
                  {!wasCorrect && (
                    <p className="quiz-answer-line correct">
                      <span className="quiz-answer-tag">Answer</span>
                      {prepared.question.correctAnswer}
                    </p>
                  )}

                  <p className="quiz-explanation">{prepared.question.explanation}</p>
                  {card && (
                    <p className="muted small">
                      From the card: {card.front} — {card.back}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="form-actions">
        <button className="ghost-btn" onClick={onExit}>
          Back to library
        </button>
        <button className="primary-btn" onClick={onAgain}>
          Test again
        </button>
      </div>
    </div>
  );
}
