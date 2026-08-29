import { useDeckQuiz } from './quiz/useDeckQuiz';
import QuizGenerating from './quiz/QuizGenerating';
import QuizSetup from './quiz/QuizSetup';
import QuizRunner from './quiz/QuizRunner';
import QuizResults from './quiz/QuizResults';

interface Props {
  deckId: string;
  onExit: () => void;
}

/**
 * Testing a deck, from writing the questions to marking the paper.
 *
 * The phases share one pool of questions — it has to survive the move from
 * setup to test to results, and App holds no domain state to lift it into — so
 * the state lives in useDeckQuiz and this component only chooses which screen
 * is showing.
 *
 * Questions are written once by the model and kept, so taking a test costs
 * nothing and works offline: nothing below the setup screen makes a network
 * request.
 */
export default function TestMode({ deckId, onExit }: Props) {
  const quiz = useDeckQuiz(deckId);

  if (quiz.phase === 'loading') return <p className="muted">Loading deck…</p>;

  // A deck that is absent and a deck that could not be read are different
  // things, and saying "couldn't be found" for a storage failure sends people
  // looking for a deck that is sitting right there.
  if (!quiz.deck && quiz.noticeFailed && quiz.notice) {
    return (
      <div className="ai-notice failed">
        <strong>This deck could not be opened</strong>
        <p>{quiz.notice}</p>
      </div>
    );
  }
  if (!quiz.deck) return <p className="muted">This deck couldn't be found.</p>;

  if (quiz.phase === 'generating') {
    return (
      <QuizGenerating
        deckName={quiz.deck.name}
        progress={quiz.progress}
        written={quiz.pool.length}
        onStop={quiz.stopGenerating}
      />
    );
  }

  if (quiz.phase === 'setup') {
    return (
      <QuizSetup
        deck={quiz.deck}
        cards={quiz.cards}
        pool={quiz.pool}
        unwritten={quiz.unwritten}
        ai={quiz.ai}
        onAiChange={quiz.setAi}
        notice={quiz.notice}
        noticeFailed={quiz.noticeFailed}
        count={quiz.count}
        onCountChange={quiz.setCount}
        onWriteMissing={() => quiz.generate(quiz.unwritten, quiz.cards, quiz.deck!.name, quiz.ai)}
        onStart={quiz.startTest}
        onExit={onExit}
      />
    );
  }

  if (quiz.phase === 'taking') {
    return (
      <QuizRunner
        asked={quiz.asked}
        position={quiz.position}
        selected={quiz.selected}
        onSelect={quiz.setSelected}
        onCommit={quiz.commitAnswer}
        cardFor={quiz.cardFor}
        onExit={onExit}
      />
    );
  }

  return (
    <QuizResults
      asked={quiz.asked}
      answers={quiz.answers}
      cardFor={quiz.cardFor}
      onAgain={() => quiz.setPhase('setup')}
      onExit={onExit}
    />
  );
}
