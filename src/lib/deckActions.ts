import { deleteDeck, deleteFolder } from '../db/db';
import { deleteFolderConfirmMessage } from './deckFolders';

/**
 * Asks before deleting a deck, then deletes it and everything in it.
 *
 * Returns true when the deck was deleted and false when the reader backed out,
 * so the caller can decide whether to navigate away or refresh a list. Throws if
 * the delete itself fails; both callers report that in their own error slot.
 *
 * The wording lives here because the two screens that can delete a deck have to
 * ask the same question. An irreversible action phrased differently in two
 * places is one people stop reading.
 */
export async function confirmAndDeleteDeck(deckId: string, name: string): Promise<boolean> {
  if (!confirm(`Delete "${name}" and all its flashcards? This can't be undone.`)) {
    return false;
  }
  await deleteDeck(deckId);
  return true;
}

/**
 * Asks before deleting a folder, then deletes it. Its decks move to Unfiled.
 *
 * The question says where the decks go, because "delete folder" beside a count
 * of decks reads as though the decks go with it — and they do not. Returns and
 * throws the same way confirmAndDeleteDeck does.
 */
export async function confirmAndDeleteFolder(
  folderId: string,
  name: string,
  deckCount: number
): Promise<boolean> {
  if (!confirm(deleteFolderConfirmMessage(name, deckCount))) return false;
  await deleteFolder(folderId);
  return true;
}
