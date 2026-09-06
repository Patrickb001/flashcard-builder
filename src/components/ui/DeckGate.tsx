import type { Deck } from '../../types';
import ErrorNotice from './ErrorNotice';

interface Props {
  loading: boolean;
  /** Why the read failed, if it did. Distinguishes "broken" from "missing". */
  error?: string | null;
  /** The deck, once read. Null both while loading and when it does not exist. */
  deck: Deck | null;
}

/**
 * The three states every deck screen has to handle before it can show a deck:
 * still reading, could not read, and no such deck.
 *
 * A deck that is absent and a deck that could not be read are different things,
 * and saying "couldn't be found" for a storage failure sends people looking for
 * a deck that is sitting right there. The error takes precedence for that
 * reason.
 *
 * Callers render this instead of their own body:
 *
 *     if (loading || error || !deck) {
 *       return <DeckGate loading={loading} error={error} deck={deck} />;
 *     }
 */
export default function DeckGate({ loading, error, deck }: Props) {
  if (loading) return <p className="muted">Loading deck…</p>;
  if (error && !deck) return <ErrorNotice title="This deck could not be opened" message={error} />;
  return <p className="muted">This deck couldn't be found.</p>;
}
