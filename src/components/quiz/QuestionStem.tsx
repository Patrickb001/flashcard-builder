import type { CardCode, TestQuestion } from '../../types';
import { styleOf } from '../../types';
import { Diagram, Snippet } from '../CardMedia';

interface Props {
  /** The question to lay out. Only its text and media are read. */
  question: TestQuestion;
  /**
   * A snippet to fall back to when the question carries none of its own.
   *
   * The source card's front code, passed while a test is being taken: a
   * question about a program is unanswerable without the program. Omitted on
   * the results screen, where the answer is already shown.
   */
  fallbackCode?: CardCode;
}

/**
 * A question as it reads: an optional scenario, the lead-in, and any media.
 *
 * The scenario sits in its own panel above the lead-in, at full text colour:
 * it is the part a reader has to study, not an aside. An application
 * question's program is part of its scenario — "What does this program
 * print?" is unanswerable until the program has been read — so it goes inside
 * that panel, ahead of the stem. For every other style the snippet is the
 * card's own and stays below the stem, where it has always been.
 *
 * Shared between taking a test and reviewing one, so a question cannot be
 * presented one way while it is being answered and another way afterwards —
 * which would make a review of a missed question a review of something the
 * reader did not see.
 */
export default function QuestionStem({ question, fallbackCode }: Props) {
  const scenarioCode = styleOf(question) === 'application' ? question.stemCode : undefined;
  return (
    <>
      {/* Board-style and application items open with a scenario; recall
          questions have none, and so does a board item whose card could not
          carry one. */}
      {(question.vignette || scenarioCode) && (
        <div className="quiz-scenario">
          {question.vignette && <p className="quiz-vignette">{question.vignette}</p>}
          {scenarioCode && <Snippet code={scenarioCode} />}
        </div>
      )}
      <p className="quiz-stem">{question.stem}</p>
      {question.stemCode && !scenarioCode && <Snippet code={question.stemCode} />}
      {question.stemImage && <Diagram image={question.stemImage} />}
      {!question.stemCode && fallbackCode && <Snippet code={fallbackCode} />}
    </>
  );
}
