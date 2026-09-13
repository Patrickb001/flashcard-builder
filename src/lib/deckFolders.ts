import type { Deck, Folder } from '../types';

/**
 * Which folder a deck is in, which decks a library view shows, and in what order.
 *
 * Kept free of React and IndexedDB so the rules can be checked under plain Node
 * (tools/test-folders.mjs). The screens render what these return, and db.ts
 * uses the name rules to refuse duplicates.
 */

/** The filter for decks in no folder, as it appears in `?folder=unfiled`. */
export const UNFILED = 'unfiled';

/**
 * What the library is showing: every deck, the Unfiled ones, or one folder by
 * id. Folder ids are UUIDs, so one can never collide with the two words.
 */
export type FolderFilter = 'all' | typeof UNFILED | string;

/** How the library orders its folders and decks. */
export type LibrarySort = 'newest' | 'name';

/** Thrown by createFolder and renameFolder when another folder already has the name. */
export class DuplicateFolderNameError extends Error {
  constructor(folderName: string) {
    super(`A folder named "${folderName}" already exists.`);
    this.name = 'DuplicateFolderNameError';
  }
}

/** A folder name as stored: trimmed, with runs of whitespace collapsed to one space. */
export function cleanFolderName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** The form two names are compared in, so "Biology" and " biology " collide. */
function folderNameKey(name: string): string {
  return cleanFolderName(name).toLocaleLowerCase();
}

/**
 * Whether `name` is already taken by a folder other than `exceptId`.
 *
 * `exceptId` is the folder being renamed, so re-casing a folder's own name
 * ("biology" to "Biology") is allowed rather than reported as a clash with itself.
 */
export function isDuplicateFolderName(name: string, folders: Folder[], exceptId?: string): boolean {
  const key = folderNameKey(name);
  return folders.some((folder) => folder.id !== exceptId && folderNameKey(folder.name) === key);
}

/**
 * The folder a deck is really in: its folderId when that folder exists, else UNFILED.
 *
 * The one place `deck.folderId` is interpreted. A deck can outlive its folder
 * for a moment — another tab deletes the folder while this one still holds the
 * deck — and that deck belongs on the Unfiled shelf, not on no shelf at all.
 */
export function folderOf(deck: Deck, folderIds: ReadonlySet<string>): string {
  return deck.folderId && folderIds.has(deck.folderId) ? deck.folderId : UNFILED;
}

/** Deck counts for every folder (empty ones at 0), then UNFILED, in that insertion order. */
export function countDecksByFolder(decks: Deck[], folders: Folder[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const folder of folders) counts.set(folder.id, 0);
  counts.set(UNFILED, 0);

  const folderIds = new Set(folders.map((folder) => folder.id));
  for (const deck of decks) {
    const key = folderOf(deck, folderIds);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** The decks a filter shows, in the order they were given. Always a new array. */
export function filterDecks(decks: Deck[], folders: Folder[], filter: FolderFilter): Deck[] {
  if (filter === 'all') return decks.slice();
  const folderIds = new Set(folders.map((folder) => folder.id));
  return decks.filter((deck) => folderOf(deck, folderIds) === filter);
}

/**
 * Reads `?folder=` into a filter.
 *
 * An id for a folder that does not exist — deleted since, or copied from
 * another browser — shows everything rather than an empty shelf that looks
 * like lost decks.
 */
export function parseFolderFilter(param: string | null, folders: Folder[]): FolderFilter {
  if (param === UNFILED) return UNFILED;
  if (param && folders.some((folder) => folder.id === param)) return param;
  return 'all';
}

/**
 * One collator for every A–Z comparison.
 *
 * `numeric` puts "Chapter 2" before "Chapter 10" — the order a plain
 * localeCompare gets wrong, and the one that reads as random. `base` ignores
 * case and accents, so "biology" and "Biology" sort together.
 */
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function newestFirst(a: { createdAt: number }, b: { createdAt: number }): number {
  return b.createdAt - a.createdAt;
}

/**
 * Sorts a copy. Names that compare equal fall back to newest first, so the order
 * never depends on how IndexedDB happened to return the records.
 */
function sortByPreference<T extends { name: string; createdAt: number }>(items: T[], sort: LibrarySort): T[] {
  const copy = items.slice();
  if (sort === 'name') {
    return copy.sort((a, b) => nameCollator.compare(a.name, b.name) || newestFirst(a, b));
  }
  return copy.sort(newestFirst);
}

/** Decks in the library's chosen order. Does not change its input. */
export function sortDecks(decks: Deck[], sort: LibrarySort): Deck[] {
  return sortByPreference(decks, sort);
}

/** Folders in the library's chosen order. Does not change its input. */
export function sortFolders(folders: Folder[], sort: LibrarySort): Folder[] {
  return sortByPreference(folders, sort);
}
