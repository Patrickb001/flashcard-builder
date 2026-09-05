import { useDeckQuiz } from './quiz/useDeckQuiz';
import QuizGenerating from './quiz/QuizGenerating';
import QuizSetup from './quiz/QuizSetup';
import QuizRunner from './quiz/QuizRunner';
import QuizResults from './quiz/QuizResults';
import DeckGate from './ui/DeckGate';

interface Props {
  /** The deck to test. Everything else is derived from it by useDeckQuiz. */
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

  if (quiz.phase === 'loading' || !quiz.deck) {
    return (
      <DeckGate
        loading={quiz.phase === 'loading'}
        // Only a failure notice counts as a read error here; the same field also
        // carries ordinary generation outcomes, which must not be reported as
        // the deck being unopenable.
        error={quiz.noticeFailed ? quiz.notice : null}
        deck={quiz.deck}
      />
    );
  }

  if (quiz.phase === 'generating') {
    return (
      <QuizGenerating
        deckName={quiz.deck.name}
        progress={quiz.progress}
        written={quiz.visiblePool.length}
        onStop={quiz.stopGenerating}
      />
    );
  }

  if (quiz.phase === 'setup') {
    return (
      <QuizSetup
        deck={quiz.deck}
        cards={quiz.cards}
        pool={quiz.visiblePool}
        unwritten={quiz.unwritten}
        style={quiz.style}
        onStyleChange={quiz.setStyle}
        ai={quiz.ai}
        onAiChange={quiz.setAi}
        notice={quiz.notice}
        noticeFailed={quiz.noticeFailed}
        count={quiz.count}
        onCountChange={quiz.setCount}
        onWriteMissing={() =>
          quiz.generate(quiz.unwritten, quiz.cards, quiz.deck!.name, quiz.ai, quiz.style)
        }
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
