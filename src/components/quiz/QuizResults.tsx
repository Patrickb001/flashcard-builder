import type { Flashcard, TestQuestion } from '../../types';
import type { PreparedQuestion } from '../../lib/quizSelection';
import { Diagram, Snippet } from '../CardMedia';

/**
 * The score, and a review of everything missed.
 *
 * Only the missed questions are reviewed. A list of what you already knew is
 * scrolling, not studying, and the explanation is written to teach the
 * distinction rather than to restate the answer.
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
  const missed = asked.filter((q, i) => answers[i] !== q.correctIndex);

  return (
    <div className="quiz">
      <div className="study-summary">
        <h2 className="quiz-score">
          {correctCount} of {asked.length}
        </h2>
        <p className="muted">{pct}% correct</p>
      </div>

      {missed.length === 0 ? (
        <p className="muted centered">Clean sheet — every answer correct.</p>
      ) : (
        <>
          <p className="eyebrow">Review — {missed.length} missed</p>
          <ul className="quiz-review">
            {missed.map((prepared) => {
              const index = asked.indexOf(prepared);
              const picked = answers[index];
              const card = cardFor(prepared.question);
              return (
                <li className="quiz-review-row" key={prepared.question.id}>
                  {prepared.question.vignette && (
                    <p className="quiz-vignette">{prepared.question.vignette}</p>
                  )}
                  <p className="quiz-stem">{prepared.question.stem}</p>
                  {prepared.question.stemCode && <Snippet code={prepared.question.stemCode} />}
                  {prepared.question.stemImage && <Diagram image={prepared.question.stemImage} />}

                  <p className="quiz-answer-line picked">
                    <span className="quiz-answer-tag">You chose</span>
                    {picked === null ? 'nothing' : prepared.options[picked]}
                  </p>
                  <p className="quiz-answer-line correct">
                    <span className="quiz-answer-tag">Answer</span>
                    {prepared.question.correctAnswer}
                  </p>
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
