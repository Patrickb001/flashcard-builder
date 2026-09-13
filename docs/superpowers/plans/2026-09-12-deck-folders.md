# Deck Folders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let decks be filed into flat, one-level folders (or left Unfiled), switch the library between showing all decks, one folder, or Unfiled, and sort the library's folders and decks by Newest or A–Z.

**Architecture:** A `folders` IndexedDB store is added in a v3 upgrade, and each deck points at its folder through an optional `Deck.folderId`. All grouping, filtering, sorting and name rules live in one pure module, `src/lib/deckFolders.ts`. It can run under Node, so the logic is tested there, and the React screens only render what it returns. The library keeps the folder being viewed in the URL (`/?folder=`) and remembers the sort choice in `localStorage`. The review screen and deck manager each get a folder `<select>`.

**Tech Stack:** TypeScript, React 18, React Router 7 (`useSearchParams`), `idb` over IndexedDB, Vite. Tests use Node 22 (`--experimental-strip-types`) for pure logic and headless Chrome (`tools/idb-check.html`) for IndexedDB.

**Spec:** `docs/superpowers/specs/2026-09-12-deck-folders-design.md`

**Task order note:** `npx tsc -b` passes after every task's commit. Task 1 contains only pure code and types, and Task 2 builds storage on top of it, so neither touches a screen. Tasks 3–5 each wire up one screen. Task 5 reuses the `.folder-select` CSS class added in Task 4, so Task 5 must run after Task 4.

## Global Constraints

- `DB_VERSION` becomes `3`. The upgrade only adds an `if (oldVersion < 3)` block that creates the `folders` store. The `oldVersion < 1` and `oldVersion < 2` blocks must not change.
- Unfiled means **the `folderId` key is absent**, not set to `undefined`. Every write that makes a deck Unfiled leaves the key off or deletes it (`saveDeckWithCards` via the review screen, `deleteFolder`, `moveDeckToFolder(id, null)`).
- Code that decides which folder a deck is in (grouping, counting, labels, select values) calls `folderOf(deck, folderIds)` and never reads `deck.folderId` directly. An id for a deleted folder counts as Unfiled.
- Exact values:
  - URL query param: `folder`
  - Unfiled filter value: `UNFILED = 'unfiled'`
  - All-decks filter value: `'all'`
  - Sort values: `LibrarySort = 'newest' | 'name'`, default `'newest'`
  - Storage key: `'flashcard-forge:library-sort'`
  - Button labels: `Newest`, `A–Z` (en dash)
- Folder names are cleaned with `cleanFolderName` (trim, then collapse internal whitespace to one space). Uniqueness is checked case-insensitively on the cleaned name. An empty cleaned name is rejected.
- A–Z sorting uses one shared `Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`. Equal names fall back to newest first.
- The library sort applies to the folder bar and the deck grid in every view. The `<select>`s on the review screen and deck manager always list folders A–Z.
- `src/lib/deckFolders.ts` and `src/lib/librarySort.ts` must be loadable by `node --experimental-strip-types`. That means type-only imports from the app (`import type`), and no `enum`, `namespace`, or constructor parameter properties.
- No new `dependencies` or `devDependencies`.
- Match each file's quote style: `DeckManager.tsx` uses double quotes and trailing commas; every other file touched here uses single quotes.
- Commit messages follow this repo's style (a sentence-case description, no `feat:` prefix) and end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Do the work on a feature branch or worktree (see superpowers:using-git-worktrees), not on `main`.

---

### Task 1: Folder types, grouping/sorting helpers, and the stored sort preference

**Files:**
- Modify: `src/types.ts`
- Create: `src/lib/deckFolders.ts`
- Create: `src/lib/librarySort.ts`
- Create: `tools/test-folders.mjs`
- Modify: `README.md` (the "Inspecting the pipeline" command block)

**Interfaces:**
- Consumes: `Deck` from `src/types.ts` (pre-existing).
- Produces:
  - `src/types.ts`: `interface Folder { id: string; name: string; createdAt: number }`; `Deck.folderId?: string`.
  - `src/lib/deckFolders.ts`:
    - `UNFILED: 'unfiled'`
    - `type FolderFilter = 'all' | typeof UNFILED | string`
    - `type LibrarySort = 'newest' | 'name'`
    - `class DuplicateFolderNameError extends Error` (its `name` is `'DuplicateFolderNameError'`)
    - `cleanFolderName(raw: string): string`
    - `isDuplicateFolderName(name: string, folders: Folder[], exceptId?: string): boolean`
    - `folderOf(deck: Deck, folderIds: ReadonlySet<string>): string`
    - `countDecksByFolder(decks: Deck[], folders: Folder[]): Map<string, number>`
    - `filterDecks(decks: Deck[], folders: Folder[], filter: FolderFilter): Deck[]`
    - `parseFolderFilter(param: string | null, folders: Folder[]): FolderFilter`
    - `sortDecks(decks: Deck[], sort: LibrarySort): Deck[]`
    - `sortFolders(folders: Folder[], sort: LibrarySort): Folder[]`
  - `src/lib/librarySort.ts`: `getStoredLibrarySort(): LibrarySort`; `storeLibrarySort(sort: LibrarySort): void`.

- [ ] **Step 1: Write the failing test**

Create `tools/test-folders.mjs`:

```js
import { getStoredLibrarySort, storeLibrarySort } from '../src/lib/librarySort.ts';
import {
  UNFILED,
  cleanFolderName,
  countDecksByFolder,
  filterDecks,
  folderOf,
  isDuplicateFolderName,
  parseFolderFilter,
  sortDecks,
  sortFolders,
} from '../src/lib/deckFolders.ts';

/**
 * Folder grouping, library sorting, and the remembered sort choice.
 *
 *   node --experimental-strip-types --import ./tools/register.mjs tools/test-folders.mjs
 *
 * Pure — no browser, no IndexedDB, no model call. The storage layer that uses
 * these rules is exercised separately, in a real browser, by tools/idb-check.html.
 */

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`}`
  );
}

const ids = (items) => items.map((item) => item.id);

const folders = [
  { id: 'f-bio', name: 'Biology', createdAt: 100 },
  { id: 'f-chem', name: 'chemistry', createdAt: 300 },
];

function deck(id, name, createdAt, folderId) {
  return {
    id,
    name,
    sourceFileName: 'notes.md',
    sourceType: 'md',
    createdAt,
    cardCount: 1,
    ...(folderId ? { folderId } : {}),
  };
}

// Newest first, the order getAllDecks hands them over in. d2 points at a
// folder that no longer exists, as it would after another tab deleted it.
const decks = [
  deck('d4', 'Chapter 10', 400, 'f-bio'),
  deck('d3', 'Chapter 2', 300, 'f-bio'),
  deck('d2', 'Orphan', 200, 'f-gone'),
  deck('d1', 'Loose', 100),
];
const folderIds = new Set(folders.map((folder) => folder.id));

console.log('\nFOLDER OF');
check('a deck in a real folder is in it', folderOf(decks[0], folderIds), 'f-bio');
check('a deck pointing at a deleted folder is unfiled', folderOf(decks[2], folderIds), UNFILED);
check('a deck with no folderId is unfiled', folderOf(decks[3], folderIds), UNFILED);

console.log('\nCOUNTS');
check(
  'every folder listed, empty ones at 0, unfiled last',
  [...countDecksByFolder(decks, folders)],
  [['f-bio', 2], ['f-chem', 0], [UNFILED, 2]]
);

console.log('\nFILTER');
check('all keeps every deck in order', ids(filterDecks(decks, folders, 'all')), ['d4', 'd3', 'd2', 'd1']);
check('a folder keeps only its decks', ids(filterDecks(decks, folders, 'f-bio')), ['d4', 'd3']);
check('unfiled includes the orphaned deck', ids(filterDecks(decks, folders, UNFILED)), ['d2', 'd1']);
check('an empty folder shows nothing', ids(filterDecks(decks, folders, 'f-chem')), []);

console.log('\nPARSE ?folder=');
check('missing param is all', parseFolderFilter(null, folders), 'all');
check('empty param is all', parseFolderFilter('', folders), 'all');
check('unfiled is unfiled', parseFolderFilter('unfiled', folders), UNFILED);
check('a real folder id is kept', parseFolderFilter('f-bio', folders), 'f-bio');
check('an unknown id falls back to all', parseFolderFilter('f-gone', folders), 'all');

console.log('\nNAMES');
check('clean trims and collapses spaces', cleanFolderName('  Organic   Chem  '), 'Organic Chem');
check('a case and space variant is a duplicate', isDuplicateFolderName(' biology ', folders), true);
check('renaming a folder to its own name is not a duplicate', isDuplicateFolderName('BIOLOGY', folders, 'f-bio'), false);
check('a new name is not a duplicate', isDuplicateFolderName('Physics', folders), false);

console.log('\nSORT');
check('name reads numbers as numbers', ids(sortDecks(decks, 'name')), ['d3', 'd4', 'd1', 'd2']);
check(
  'name ignores case, and equal names fall back to newest first',
  ids(sortDecks([deck('a', 'biology', 100), deck('b', 'Biology', 200)], 'name')),
  ['b', 'a']
);
check('newest is createdAt descending', ids(sortDecks([decks[3], decks[1], decks[0], decks[2]], 'newest')), ['d4', 'd3', 'd2', 'd1']);
check('folders by name ignore case', ids(sortFolders([...folders].reverse(), 'name')), ['f-bio', 'f-chem']);
check('folders by newest', ids(sortFolders(folders, 'newest')), ['f-chem', 'f-bio']);
const input = decks.slice();
sortDecks(input, 'name');
sortFolders(folders, 'newest');
check('sorting does not change its input', ids(input), ['d4', 'd3', 'd2', 'd1']);

console.log('\nSTORED SORT');
check('no localStorage at all falls back to newest', getStoredLibrarySort(), 'newest');

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
};
check('nothing stored is newest', getStoredLibrarySort(), 'newest');
storeLibrarySort('name');
check('the choice is written under its key', store.get('flashcard-forge:library-sort'), 'name');
check('a stored name is read back', getStoredLibrarySort(), 'name');
store.set('flashcard-forge:library-sort', 'oldest');
check('an unrecognised value is newest', getStoredLibrarySort(), 'newest');

globalThis.localStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};
check('a throwing read is newest', getStoredLibrarySort(), 'newest');
let threw = false;
try {
  storeLibrarySort('name');
} catch {
  threw = true;
}
check('a throwing write is swallowed', threw, false);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-folders.mjs`
Expected: FAIL. The process exits non-zero with `ERR_MODULE_NOT_FOUND` for `src/lib/librarySort.ts`.

- [ ] **Step 3: Add the `Folder` type and `Deck.folderId`**

In `src/types.ts`, find this exact block:

```ts
  /**
   * Cards in this deck, kept in step by addCard and deleteCard so the library
   * can show a count without reading the cards themselves.
   */
  cardCount: number;
}
```

Replace it with:

```ts
  /**
   * Cards in this deck, kept in step by addCard and deleteCard so the library
   * can show a count without reading the cards themselves.
   */
  cardCount: number;
  /**
   * The folder this deck is filed in. Absent means Unfiled — which is every
   * deck saved before folders existed, so there is nothing to migrate.
   *
   * Never read this directly to decide where a deck belongs: it can name a
   * folder another tab has since deleted. Go through folderOf in
   * lib/deckFolders, which treats that as Unfiled.
   */
  folderId?: string;
}

/**
 * A named group of decks, one level deep.
 *
 * Holds no deck ids. Decks point at their folder instead, so moving a deck is
 * one write and deleting a deck never has to touch a folder.
 */
export interface Folder {
  id: string;
  name: string;
  createdAt: number;
}
```

- [ ] **Step 4: Create the pure helpers**

Create `src/lib/deckFolders.ts`:

```ts
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
```

- [ ] **Step 5: Create the stored sort preference**

Create `src/lib/librarySort.ts`:

```ts
import type { LibrarySort } from './deckFolders';

const STORAGE_KEY = 'flashcard-forge:library-sort';

/**
 * The library order last chosen, or 'newest' when nothing usable is stored.
 *
 * Kept like the theme (lib/theme.ts) rather than in the URL: it is a standing
 * preference, and a URL param would be dropped every time the library is
 * reached from another screen.
 */
export function getStoredLibrarySort(): LibrarySort {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'name' ? 'name' : 'newest';
  } catch {
    // Storage can be unavailable in a locked-down browsing context.
    return 'newest';
  }
}

/** Remembers the library order for next time. */
export function storeLibrarySort(sort: LibrarySort): void {
  try {
    localStorage.setItem(STORAGE_KEY, sort);
  } catch {
    // Not remembered, but the library is still sorted — not worth failing the
    // switch over.
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-folders.mjs`
Expected: every line starts with `ok`, the output ends `All checks passed.`, and the exit code is 0.

- [ ] **Step 7: Type-check**

Run: `npx tsc -b`
Expected: exits 0 with no output.

- [ ] **Step 8: Document the new test command**

In `README.md`, find this exact block:

````markdown
node --experimental-strip-types --import ./tools/register.mjs \
  tools/test-quiz.mjs
```
````

Replace it with:

````markdown
node --experimental-strip-types --import ./tools/register.mjs \
  tools/test-quiz.mjs

# Folder grouping, library sorting, and the remembered sort choice. Pure; no key.
node --experimental-strip-types --import ./tools/register.mjs \
  tools/test-folders.mjs
```
````

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/lib/deckFolders.ts src/lib/librarySort.ts tools/test-folders.mjs README.md
git commit -m "Add folder types and the pure grouping, sorting and name rules behind deck folders

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Folder storage — the v3 upgrade and folder writes in `db.ts`

**Files:**
- Modify: `src/db/db.ts`
- Test: `tools/idb-check.html`

**Interfaces:**
- Consumes: `Folder` from `src/types.ts`; `DuplicateFolderNameError`, `cleanFolderName`, `isDuplicateFolderName` from `src/lib/deckFolders.ts` (all from Task 1).
- Produces (all exported from `src/db/db.ts`):
  - `getAllFolders(): Promise<Folder[]>`, unordered.
  - `createFolder(name: string): Promise<Folder>`. Throws `DuplicateFolderNameError` if the name is taken, or `Error('A folder needs a name.')` if it is empty.
  - `renameFolder(folderId: string, name: string): Promise<void>`. Throws the same errors. Does nothing if the folder is gone.
  - `deleteFolder(folderId: string): Promise<void>`. Removes `folderId` from that folder's decks in the same transaction.
  - `moveDeckToFolder(deckId: string, folderId: string | null): Promise<void>`. `null` makes the deck Unfiled. Throws `Error('That folder no longer exists.')` for an unknown folder id.

- [ ] **Step 1: Write the failing browser checks**

In `tools/idb-check.html`, find this exact line:

```js
    // ---- 1. concurrent addCard must not lose an increment ----
```

Replace it with:

```js
    // ---- 0. a v2 database upgrades to v3 with nothing lost ----
    // Runs first, before anything has opened the database through db.ts: it
    // DELETES the app's database and rebuilds it at version 2 by hand. Only run
    // this page in a throwaway browser profile (a fresh --user-data-dir).
    {
      const settle = (req) =>
        new Promise((resolve, reject) => {
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      await settle(indexedDB.deleteDatabase('flashcard-forge'));

      const id = 'probe-v2';
      const openV2 = indexedDB.open('flashcard-forge', 2);
      openV2.onupgradeneeded = () => {
        const raw = openV2.result;
        const decks = raw.createObjectStore('decks', { keyPath: 'id' });
        decks.createIndex('by-createdAt', 'createdAt');
        const cards = raw.createObjectStore('flashcards', { keyPath: 'id' });
        cards.createIndex('by-deckId', 'deckId');
        const questions = raw.createObjectStore('testQuestions', { keyPath: 'id' });
        questions.createIndex('by-deckId', 'deckId');
        questions.createIndex('by-cardId', 'cardId');

        decks.put({ ...deck(id), cardCount: 1 });
        cards.put(card(id, 0));
        questions.put({
          id: 'probe-v2-q', deckId: id, cardId: id + '-c0', stem: 'S', correctAnswer: 'R',
          distractors: ['a', 'b', 'c'], explanation: 'E', cardHash: 'h',
          createdAt: Date.now(), timesAsked: 0, lastAskedAt: null, timesCorrect: 0,
        });
      };
      (await settle(openV2)).close();

      const upgraded = await db.getDeck(id);
      const upgradedCards = await db.getCardsForDeck(id);
      const upgradedQuestions = await db.getQuestionsForDeck(id);
      const folders = await db.getAllFolders();
      check('v2 upgrade: deck kept', !!upgraded && upgraded.name === id, JSON.stringify(upgraded));
      check('v2 upgrade: deck is unfiled', !!upgraded && !('folderId' in upgraded));
      check('v2 upgrade: cards kept', upgradedCards.length === 1, upgradedCards.length + '/1');
      check('v2 upgrade: questions kept', upgradedQuestions.length === 1, upgradedQuestions.length + '/1');
      check('v2 upgrade: folders store exists and is empty', Array.isArray(folders) && folders.length === 0, JSON.stringify(folders));
      await db.deleteDeck(id);
    }

    // ---- 1. concurrent addCard must not lose an increment ----
```

Then find this exact block. It is the end of check 4 and the start of the summary:

```js
      check('correct tally kept', back.timesCorrect === 1, 'timesCorrect=' + back.timesCorrect);
      await db.deleteDeck(id);
    }

    log('');
```

Replace it with:

```js
      check('correct tally kept', back.timesCorrect === 1, 'timesCorrect=' + back.timesCorrect);
      await db.deleteDeck(id);
    }

    // ---- 5. deleteFolder unfiles its decks, and only its decks ----
    {
      const keep = await db.createFolder('probe keep');
      const drop = await db.createFolder('probe drop');
      await db.saveDeckWithCards({ ...deck('probe-in-drop'), folderId: drop.id }, []);
      await db.saveDeckWithCards({ ...deck('probe-in-keep'), folderId: keep.id }, []);

      await db.deleteFolder(drop.id);

      const folders = await db.getAllFolders();
      const inDrop = await db.getDeck('probe-in-drop');
      const inKeep = await db.getDeck('probe-in-keep');
      check('deleteFolder removes the folder', !folders.some((f) => f.id === drop.id));
      check('deleteFolder keeps the folder\'s decks', !!inDrop);
      check('deleteFolder unfiles them (key removed)', !!inDrop && !('folderId' in inDrop), JSON.stringify(inDrop));
      check('deleteFolder leaves other folders\' decks alone', !!inKeep && inKeep.folderId === keep.id, JSON.stringify(inKeep));

      await db.deleteDeck('probe-in-drop');
      await db.deleteDeck('probe-in-keep');
      await db.deleteFolder(keep.id);
    }

    // ---- 6. moveDeckToFolder must not clobber a concurrent cardCount ----
    {
      const id = 'probe-move';
      const folder = await db.createFolder('probe move target');
      await db.saveDeckWithCards(deck(id), []);
      const N = 15;
      await Promise.all([
        ...Array.from({ length: N }, (_, i) => db.addCard(card(id, i))),
        db.moveDeckToFolder(id, folder.id),
      ]);
      const moved = await db.getDeck(id);
      check('move racing 15 adds: cardCount survives', moved.cardCount === N, moved.cardCount + '/' + N);
      check('move racing 15 adds: folder applied', moved.folderId === folder.id, String(moved.folderId));

      await db.moveDeckToFolder(id, null);
      const unfiled = await db.getDeck(id);
      check('move to null unfiles (key removed)', !('folderId' in unfiled), JSON.stringify(unfiled));

      let refused = false;
      try {
        await db.moveDeckToFolder(id, 'probe-no-such-folder');
      } catch {
        refused = true;
      }
      check('move into a missing folder is refused', refused);

      await db.deleteDeck(id);
      await db.deleteFolder(folder.id);
    }

    // ---- 7. folder names are unique, ignoring case and spacing ----
    {
      const rejectsAsDuplicate = async (fn) => {
        try {
          await fn();
          return false;
        } catch (err) {
          return !!err && err.name === 'DuplicateFolderNameError';
        }
      };
      const a = await db.createFolder('Probe Names');
      const b = await db.createFolder('Probe Other');

      check('createFolder rejects a case/space variant', await rejectsAsDuplicate(() => db.createFolder('  probe   names ')));
      check('renameFolder rejects another folder\'s name', await rejectsAsDuplicate(() => db.renameFolder(b.id, 'PROBE NAMES')));

      await db.renameFolder(a.id, 'probe names');
      const recased = (await db.getAllFolders()).find((f) => f.id === a.id);
      check('renameFolder allows re-casing its own name', !!recased && recased.name === 'probe names', JSON.stringify(recased));

      let emptyRefused = false;
      try {
        await db.createFolder('   ');
      } catch {
        emptyRefused = true;
      }
      check('createFolder rejects an empty name', emptyRefused);

      await db.deleteFolder(a.id);
      await db.deleteFolder(b.id);
    }

    log('');
```

- [ ] **Step 2: Run the browser checks to verify they fail**

Run this from the repo root on macOS. On another OS, use that system's Chrome binary path. The database is deleted inside a throwaway profile under `/tmp`, never in your real browser profile.

```bash
rm -rf /tmp/ffidb /tmp/idb-result.txt
npx vite --port 5199 --strictPort > /tmp/idb-vite.log 2>&1 &
VITE_PID=$!
node tools/idb-collector.cjs /tmp/idb-result.txt &
COLLECTOR_PID=$!
sleep 4
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --user-data-dir=/tmp/ffidb http://localhost:5199/tools/idb-check.html > /dev/null 2>&1 &
CHROME_PID=$!
wait $COLLECTOR_PID
kill $CHROME_PID $VITE_PID
cat /tmp/idb-result.txt
```

Expected: the output ends in `RESULT: ERROR`, with a `THREW:` line saying `db.getAllFolders is not a function`.

- [ ] **Step 3: Import the folder type and name rules**

In `src/db/db.ts`, find this exact block:

```ts
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Deck, Flashcard, TestQuestion } from '../types';
```

Replace it with:

```ts
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Deck, Flashcard, Folder, TestQuestion } from '../types';
import { DuplicateFolderNameError, cleanFolderName, isDuplicateFolderName } from '../lib/deckFolders';
```

- [ ] **Step 4: Add the store to the schema and bump the version**

In `src/db/db.ts`, find this exact block:

```ts
  testQuestions: {
    key: string;
    value: TestQuestion;
    indexes: { 'by-deckId': string; 'by-cardId': string };
  };
}

const DB_NAME = 'flashcard-forge';
const DB_VERSION = 2;
```

Replace it with:

```ts
  testQuestions: {
    key: string;
    value: TestQuestion;
    indexes: { 'by-deckId': string; 'by-cardId': string };
  };
  /**
   * No index, and none on decks by folder: the library reads every deck anyway,
   * and an index on `folderId` would silently leave out the Unfiled decks,
   * whose key is absent.
   */
  folders: {
    key: string;
    value: Folder;
  };
}

const DB_NAME = 'flashcard-forge';
const DB_VERSION = 3;
```

- [ ] **Step 5: Add the upgrade block**

In `src/db/db.ts`, find this exact block:

```ts
        if (oldVersion < 2) {
          const questionStore = db.createObjectStore('testQuestions', { keyPath: 'id' });
          questionStore.createIndex('by-deckId', 'deckId');
          questionStore.createIndex('by-cardId', 'cardId');
        }
```

Replace it with:

```ts
        if (oldVersion < 2) {
          const questionStore = db.createObjectStore('testQuestions', { keyPath: 'id' });
          questionStore.createIndex('by-deckId', 'deckId');
          questionStore.createIndex('by-cardId', 'cardId');
        }

        // Additive only. Existing decks gain no field: an absent folderId is
        // what Unfiled means, so every deck from v2 arrives already filed.
        if (oldVersion < 3) {
          db.createObjectStore('folders', { keyPath: 'id' });
        }
```

In the same file's doc comment on `upgrade`, find:

```ts
       * app — so a first run falls through every block and gets all three.
```

Replace it with:

```ts
       * app — so a first run falls through every block and gets every store.
```

- [ ] **Step 6: Add the folder functions**

At the very end of `src/db/db.ts`, after the closing `}` of `renameDeck`, append:

```ts

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

/** A cleaned folder name, or a thrown error when nothing is left after cleaning. */
function requireFolderName(name: string): string {
  const cleaned = cleanFolderName(name);
  if (!cleaned) throw new Error('A folder needs a name.');
  return cleaned;
}

/** Every folder, in no particular order. Screens sort them with sortFolders. */
export async function getAllFolders(): Promise<Folder[]> {
  const db = await getDB();
  return db.getAll('folders');
}

/**
 * Creates a folder, refusing a name another folder already has.
 *
 * The existing names are read inside the same readwrite transaction as the
 * write. Readwrite transactions on one store run one at a time, so two tabs
 * creating "Biology" at once cannot both pass the check.
 */
export async function createFolder(name: string): Promise<Folder> {
  const cleaned = requireFolderName(name);
  const db = await getDB();
  const tx = db.transaction('folders', 'readwrite');

  const existing = await tx.store.getAll();
  if (isDuplicateFolderName(cleaned, existing)) throw new DuplicateFolderNameError(cleaned);

  const folder: Folder = { id: crypto.randomUUID(), name: cleaned, createdAt: Date.now() };
  await Promise.all([tx.store.put(folder), tx.done]);
  return folder;
}

/**
 * Renames a folder, refusing a name a different folder already has.
 *
 * Re-casing a folder's own name is allowed. A folder deleted in the meantime
 * is left deleted rather than recreated.
 */
export async function renameFolder(folderId: string, name: string): Promise<void> {
  const cleaned = requireFolderName(name);
  const db = await getDB();
  const tx = db.transaction('folders', 'readwrite');

  const all = await tx.store.getAll();
  const folder = all.find((candidate) => candidate.id === folderId);
  if (folder) {
    if (isDuplicateFolderName(cleaned, all, folderId)) throw new DuplicateFolderNameError(cleaned);
    folder.name = cleaned;
    await tx.store.put(folder);
  }

  await tx.done;
}

/**
 * Deletes a folder and moves its decks to Unfiled. No deck is deleted.
 *
 * One transaction across both stores, so the folder cannot disappear while
 * decks written in this tab still point at it. The key is deleted rather than
 * set to undefined, so an unfiled deck looks exactly like one saved before
 * folders existed.
 */
export async function deleteFolder(folderId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['folders', 'decks'], 'readwrite');
  await tx.objectStore('folders').delete(folderId);

  let cursor = await tx.objectStore('decks').openCursor();
  while (cursor) {
    if (cursor.value.folderId === folderId) {
      const unfiled: Deck = { ...cursor.value };
      delete unfiled.folderId;
      await cursor.update(unfiled);
    }
    cursor = await cursor.continue();
  }

  await tx.done;
}

/**
 * Files a deck in a folder, or in no folder when `folderId` is null.
 *
 * Read and write in one transaction, for the reason renameDeck gives: apart, a
 * cardCount written by an addCard in the gap is silently reverted. The folder
 * is checked in the same transaction, so a deck is never pointed at a folder
 * another tab has just deleted.
 */
export async function moveDeckToFolder(deckId: string, folderId: string | null): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['decks', 'folders'], 'readwrite');

  if (folderId !== null && !(await tx.objectStore('folders').get(folderId))) {
    throw new Error('That folder no longer exists.');
  }

  const deckStore = tx.objectStore('decks');
  const deck = await deckStore.get(deckId);
  if (deck) {
    if (folderId === null) delete deck.folderId;
    else deck.folderId = folderId;
    await deckStore.put(deck);
  }

  await tx.done;
}
```

- [ ] **Step 7: Run the browser checks to verify they pass**

Run the same command block as Step 2.
Expected: every line starts with `ok`, including the new `v2 upgrade:`, `deleteFolder`, `move racing 15 adds`, `move to null`, `move into a missing folder`, `createFolder rejects` and `renameFolder` lines, and the output ends `RESULT: ALL PASSED`.

- [ ] **Step 8: Type-check and re-run the pure tests**

Run: `npx tsc -b && node --experimental-strip-types --import ./tools/register.mjs tools/test-folders.mjs`
Expected: `tsc` exits 0, then `All checks passed.`

- [ ] **Step 9: Commit**

```bash
git add src/db/db.ts tools/idb-check.html
git commit -m "Store folders in a v3 database upgrade, with atomic folder deletes and deck moves

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Library folder bar, sort switch, and folder rename/delete

**Files:**
- Modify: `src/lib/deckActions.ts`
- Modify (full rewrite): `src/routes/LibraryRoute.tsx`
- Modify (full rewrite): `src/components/DeckLibrary.tsx`
- Modify: `src/index.css` (the "Deck library" section)

**Interfaces:**
- Consumes:
  - From Task 1 (`src/lib/deckFolders.ts`): `UNFILED`, `FolderFilter`, `LibrarySort`, `DuplicateFolderNameError`, `cleanFolderName`, `countDecksByFolder`, `filterDecks`, `folderOf`, `parseFolderFilter`, `sortDecks`, `sortFolders`.
  - From Task 1 (`src/lib/librarySort.ts`): `getStoredLibrarySort`, `storeLibrarySort`.
  - From Task 2 (`src/db/db.ts`): `getAllFolders`, `createFolder`, `renameFolder`, `deleteFolder`.
- Produces:
  - `confirmAndDeleteFolder(folderId: string, name: string, deckCount: number): Promise<boolean>` in `src/lib/deckActions.ts`.
  - The library links to `/upload?folder=<id>` when a folder is open, which Task 5 reads.
  - CSS classes `.library-header-actions`, `.sort-switch`, `.folder-bar`, `.folder-chip`, `.folder-chip-count`, `.folder-toolbar`, `.folder-title-input`, `.deck-card-tags`, `.folder-tag`, `.empty-state.compact`.

This project has no React component test harness. The logic behind this screen is covered by Task 1's `tools/test-folders.mjs`; the screen itself is verified by hand in Step 6.

- [ ] **Step 1: Add the folder delete confirmation**

Replace the whole of `src/lib/deckActions.ts` with:

```ts
import { deleteDeck, deleteFolder } from '../db/db';

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
  const question =
    deckCount === 0
      ? `Delete the empty folder "${name}"?`
      : `Delete the folder "${name}"? Its ${deckCount} deck${deckCount === 1 ? '' : 's'} will move to Unfiled. No decks are deleted.`;
  if (!confirm(question)) return false;
  await deleteFolder(folderId);
  return true;
}
```

- [ ] **Step 2: Load folders in the route and keep the view in the URL**

Replace the whole of `src/routes/LibraryRoute.tsx` with:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Deck, Folder } from '../types';
import { getAllDecks, getAllFolders, onUpgradeBlocked } from '../db/db';
import { parseFolderFilter } from '../lib/deckFolders';
import DeckLibrary from '../components/DeckLibrary';

/**
 * The deck shelf, its folders, and the state behind them.
 *
 * The lists belong to this route rather than to App, so arriving here mounts it
 * and loading is simply what mounting does. No other screen has to remember to
 * refresh the library after saving or deleting a deck.
 *
 * Which folder is open lives in the URL (`?folder=`), so Back, reload and a
 * copied link all return to the same view.
 */
export default function LibraryRoute() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [decks, setDecks] = useState<Deck[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // loading is cleared on both paths. Clearing it only on success is what
  // left this screen spinning forever whenever IndexedDB was unavailable -
  // a private window, a full disk, storage switched off.
  const refreshLibrary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Read together, so the folder bar's counts and the grid always describe
      // the same moment.
      const [allDecks, allFolders] = await Promise.all([getAllDecks(), getAllFolders()]);
      setDecks(allDecks);
      setFolders(allFolders);
    } catch (err) {
      console.error('[app] Could not read the deck list:', err);
      setError(
        'Your decks could not be read from this browser. They are stored locally, so a private window or blocked site data will do this.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshLibrary();
  }, [refreshLibrary]);

  /**
   * Reports an upgrade another tab is holding open.
   *
   * That case never rejects and never resolves — idb's open promise simply
   * never settles — so the catch above cannot see it, and without this the
   * screen would spin forever with nothing to explain why.
   */
  useEffect(() => {
    return onUpgradeBlocked(() => {
      setError(
        'Another tab has an older version of this app open, which is blocking an upgrade. Close the other tabs and reload.'
      );
      setLoading(false);
    });
  }, []);

  const filter = parseFolderFilter(searchParams.get('folder'), folders);

  return (
    <DeckLibrary
      decks={decks}
      folders={folders}
      filter={filter}
      loading={loading}
      error={error}
      onNewDeck={(folderId) =>
        navigate(folderId ? `/upload?folder=${encodeURIComponent(folderId)}` : '/upload')
      }
      onSelectFolder={(next) => setSearchParams(next === 'all' ? {} : { folder: next })}
      onStudy={(deckId) => navigate(`/deck/${deckId}/study`)}
      onManage={(deckId) => navigate(`/deck/${deckId}`)}
      onLibraryChange={refreshLibrary}
    />
  );
}
```

- [ ] **Step 3: Rewrite the library screen**

Replace the whole of `src/components/DeckLibrary.tsx` with:

```tsx
import { useEffect, useMemo, useState } from 'react';
import type { Deck, Folder } from '../types';
import { createFolder, renameFolder } from '../db/db';
import { confirmAndDeleteDeck, confirmAndDeleteFolder } from '../lib/deckActions';
import {
  DuplicateFolderNameError,
  UNFILED,
  cleanFolderName,
  countDecksByFolder,
  filterDecks,
  folderOf,
  sortDecks,
  sortFolders,
  type FolderFilter,
  type LibrarySort,
} from '../lib/deckFolders';
import { getStoredLibrarySort, storeLibrarySort } from '../lib/librarySort';
import ErrorNotice from './ui/ErrorNotice';

interface Props {
  /** Every saved deck, newest first. Loaded by the route, not by this screen. */
  decks: Deck[];
  /** Every folder, unordered. Sorted here, alongside the decks. */
  folders: Folder[];
  /** Which part of the shelf to show, already checked against `folders` by the route. */
  filter: FolderFilter;
  loading: boolean;
  /** Why the deck list could not be read, if it could not be. */
  error?: string | null;
  /** Starts a new deck, preselecting `folderId` on the review screen when given. */
  onNewDeck: (folderId?: string) => void;
  /** Changes which part of the shelf is shown. The route keeps it in the URL. */
  onSelectFolder: (filter: FolderFilter) => void;
  onStudy: (deckId: string) => void;
  onManage: (deckId: string) => void;
  /** Fired after a deck or folder changes, so the route can re-read both lists. */
  onLibraryChange: () => Promise<void>;
}

const SORT_OPTIONS: { value: LibrarySort; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'name', label: 'A–Z' },
];

/** The message for a failed folder write. A duplicate name is worth showing as it is. */
function folderErrorMessage(err: unknown, fallback: string): string {
  return err instanceof DuplicateFolderNameError ? err.message : fallback;
}

/**
 * The deck shelf: a folder bar, a sort switch, and the decks the chosen folder
 * holds, with an empty state for a first visit.
 *
 * Presentational apart from the writes a shelf owns — deleting a deck, and
 * creating, renaming and deleting folders. The lists themselves are loaded and
 * owned by LibraryRoute, so nothing else in the app has to refresh them.
 */
export default function DeckLibrary({
  decks,
  folders,
  filter,
  loading,
  error,
  onNewDeck,
  onSelectFolder,
  onStudy,
  onManage,
  onLibraryChange,
}: Props) {
  const [actionError, setActionError] = useState<string | null>(null);
  // Read on the first render rather than in an effect: set afterwards, the
  // grid draws once in the wrong order before correcting itself.
  const [sort, setSort] = useState<LibrarySort>(getStoredLibrarySort);
  const [folderNameDraft, setFolderNameDraft] = useState('');

  const folderIds = useMemo(() => new Set(folders.map((folder) => folder.id)), [folders]);
  const folderNames = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.name])),
    [folders]
  );
  const counts = useMemo(() => countDecksByFolder(decks, folders), [decks, folders]);
  const sortedFolders = useMemo(() => sortFolders(folders, sort), [folders, sort]);
  const visibleDecks = useMemo(
    () => sortDecks(filterDecks(decks, folders, filter), sort),
    [decks, folders, filter, sort]
  );
  const selectedFolder = folders.find((folder) => folder.id === filter) ?? null;

  // The folder name is a draft the reader edits, so it is re-seeded whenever a
  // different folder is opened or the open one is renamed.
  useEffect(() => {
    setFolderNameDraft(selectedFolder?.name ?? '');
  }, [selectedFolder?.id, selectedFolder?.name]);

  const changeSort = (next: LibrarySort) => {
    setSort(next);
    storeLibrarySort(next);
  };

  /**
   * Arrow keys move between the two sort options, as in any radio group.
   * Selection follows focus, which is what a radio group does natively.
   */
  const handleSortKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next: LibrarySort = sort === 'newest' ? 'name' : 'newest';
    changeSort(next);
    e.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-sort="${next}"]`)
      ?.focus();
  };

  /**
   * Deletes a deck from its card's delete button.
   *
   * The click is stopped from propagating because the whole card is itself a
   * button that opens the deck — without it, deleting would also navigate.
   */
  const handleDelete = async (e: React.MouseEvent, deckId: string, name: string) => {
    e.stopPropagation();
    try {
      setActionError(null);
      if (await confirmAndDeleteDeck(deckId, name)) await onLibraryChange();
    } catch (err) {
      console.error('[library] Deleting the deck failed:', err);
      setActionError(`"${name}" could not be deleted.`);
    }
  };

  /** Asks for a name, creates the folder, and opens it. */
  const handleNewFolder = async () => {
    const name = prompt('Name the new folder');
    if (name === null || !cleanFolderName(name)) return;
    try {
      setActionError(null);
      const folder = await createFolder(name);
      // Refreshed first: until the route holds the new folder, its id would
      // not survive parseFolderFilter and the shelf would fall back to All.
      await onLibraryChange();
      onSelectFolder(folder.id);
    } catch (err) {
      console.error('[library] Creating the folder failed:', err);
      setActionError(folderErrorMessage(err, 'The folder could not be created.'));
    }
  };

  /** Saves a renamed folder on blur, restoring the old name if the write fails. */
  const commitFolderName = async () => {
    if (!selectedFolder) return;
    const cleaned = cleanFolderName(folderNameDraft);
    if (!cleaned || cleaned === selectedFolder.name) {
      setFolderNameDraft(selectedFolder.name);
      return;
    }
    try {
      setActionError(null);
      await renameFolder(selectedFolder.id, cleaned);
      await onLibraryChange();
    } catch (err) {
      console.error('[library] Renaming the folder failed:', err);
      setActionError(folderErrorMessage(err, 'The folder could not be renamed.'));
      setFolderNameDraft(selectedFolder.name);
    }
  };

  /** Deletes the open folder after confirming. Its decks move to Unfiled. */
  const handleDeleteFolder = async () => {
    if (!selectedFolder) return;
    try {
      setActionError(null);
      const deckCount = counts.get(selectedFolder.id) ?? 0;
      if (await confirmAndDeleteFolder(selectedFolder.id, selectedFolder.name, deckCount)) {
        onSelectFolder('all');
        await onLibraryChange();
      }
    } catch (err) {
      console.error('[library] Deleting the folder failed:', err);
      setActionError(`The folder "${selectedFolder.name}" could not be deleted.`);
    }
  };

  const ready = !loading && !error;
  // The first-visit empty state is for a shelf with nothing on it at all. Once
  // a folder exists, the folder bar is shown even with no decks.
  const firstVisit = ready && decks.length === 0 && folders.length === 0;
  const shelfVisible = ready && !firstVisit;

  const folderChip = (value: FolderFilter, label: string, count: number) => (
    <button
      key={value}
      type="button"
      className={`mode-chip folder-chip${filter === value ? ' active' : ''}`}
      aria-pressed={filter === value}
      onClick={() => onSelectFolder(value)}
    >
      {label}
      <span className="folder-chip-count">{count}</span>
    </button>
  );

  return (
    <div className="library">
      <div className="library-header">
        <div>
          <p className="eyebrow">Your card catalog</p>
          <h1>Decks on the shelf</h1>
        </div>
        <div className="library-header-actions">
          {shelfVisible && (
            <div className="sort-switch" role="radiogroup" aria-label="Sort folders and decks">
              {SORT_OPTIONS.map((option) => {
                const checked = sort === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    tabIndex={checked ? 0 : -1}
                    data-sort={option.value}
                    className={`mode-chip${checked ? ' active' : ''}`}
                    onClick={() => changeSort(option.value)}
                    onKeyDown={handleSortKey}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          )}
          <button className="primary-btn" onClick={() => onNewDeck(selectedFolder?.id)}>
            + New deck from a file
          </button>
        </div>
      </div>

      {loading && <p className="muted">Loading your decks…</p>}

      {error && <ErrorNotice title="Your decks could not be loaded" message={error} />}

      {actionError && <ErrorNotice message={actionError} />}

      {firstVisit && (
        <div className="empty-state">
          <div className="chalk-doodle" aria-hidden="true">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="7" width="14" height="10" rx="2" />
              <path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h9A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H17" />
            </svg>
          </div>
          <h2>The shelf is empty</h2>
          <p>Upload a PDF or PowerPoint and Flashcard Forge will draft a deck for you to review.</p>
          <button className="primary-btn" onClick={() => onNewDeck()}>
            Upload your first document
          </button>
        </div>
      )}

      {shelfVisible && (
        <>
          {/* All first and Unfiled last whatever the sort; only real folders move. */}
          <nav className="folder-bar" aria-label="Folders">
            {folderChip('all', 'All decks', decks.length)}
            {sortedFolders.map((folder) =>
              folderChip(folder.id, folder.name, counts.get(folder.id) ?? 0)
            )}
            {folderChip(UNFILED, 'Unfiled', counts.get(UNFILED) ?? 0)}
            <button type="button" className="mode-chip folder-chip new-folder" onClick={handleNewFolder}>
              + New folder
            </button>
          </nav>

          {selectedFolder && (
            <div className="folder-toolbar">
              <input
                className="folder-title-input"
                aria-label="Folder name"
                value={folderNameDraft}
                onChange={(e) => setFolderNameDraft(e.target.value)}
                onBlur={commitFolderName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
              <button className="ghost-btn small danger-text" onClick={handleDeleteFolder}>
                Delete folder
              </button>
            </div>
          )}

          {visibleDecks.length === 0 ? (
            <div className="empty-state compact">
              <h2>
                {selectedFolder
                  ? 'No decks in this folder yet'
                  : filter === UNFILED
                    ? 'No unfiled decks'
                    : 'No decks yet'}
              </h2>
              <button className="primary-btn" onClick={() => onNewDeck(selectedFolder?.id)}>
                {selectedFolder ? `Upload a document into ${selectedFolder.name}` : 'Upload a document'}
              </button>
            </div>
          ) : (
            <div className="deck-grid">
              {visibleDecks.map((deck) => {
                const deckFolder = folderOf(deck, folderIds);
                // Only in All: inside a folder the tag would repeat its name on every card.
                const folderName =
                  filter === 'all' && deckFolder !== UNFILED ? folderNames.get(deckFolder) : undefined;
                return (
                  <div key={deck.id} className="deck-card" onClick={() => onManage(deck.id)}>
                    <div className="deck-card-top">
                      <div className="deck-card-tags">
                        <span className={`source-tag source-${deck.sourceType}`}>{deck.sourceType}</span>
                        {folderName && (
                          <span className="folder-tag" title={folderName}>
                            {folderName}
                          </span>
                        )}
                      </div>
                      <button
                        className="icon-btn danger"
                        title="Delete deck"
                        onClick={(e) => handleDelete(e, deck.id, deck.name)}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                    <h3>{deck.name}</h3>
                    <p className="deck-meta">
                      {deck.cardCount} card{deck.cardCount === 1 ? '' : 's'} · from {deck.sourceFileName}
                    </p>
                    <div className="deck-card-actions">
                      <button
                        className="secondary-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onStudy(deck.id);
                        }}
                      >
                        Study
                      </button>
                      <button
                        className="ghost-btn small"
                        onClick={(e) => {
                          e.stopPropagation();
                          onManage(deck.id);
                        }}
                      >
                        Manage cards
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Style the folder bar, sort switch and folder toolbar**

In `src/index.css`, find this exact block:

```css
.empty-state {
  border: 1px dashed var(--border-strong);
```

Replace it with:

```css
.library-header-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

/* Two .mode-chips joined into one control; the chips keep their own look. */
.sort-switch {
  display: inline-flex;
  gap: 0.2rem;
  padding: 0.2rem;
  border: 1px solid var(--border-soft);
  border-radius: 100px;
}

.sort-switch .mode-chip {
  border-color: transparent;
  padding: 0.3rem 0.8rem;
}

.sort-switch .mode-chip.active {
  border-color: var(--accent);
}

/* One line that scrolls sideways on a narrow screen rather than wrapping into
   a stack of chips that pushes the decks off the first screen. */
.folder-bar {
  display: flex;
  gap: 0.5rem;
  overflow-x: auto;
  padding-bottom: 0.35rem;
  margin-bottom: 1.25rem;
  scrollbar-width: thin;
}

.folder-chip {
  flex-shrink: 0;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.folder-chip-count {
  font-size: 0.75rem;
  color: var(--text-faint);
}

.folder-chip.active .folder-chip-count {
  color: inherit;
}

.folder-chip.new-folder {
  border-style: dashed;
}

.folder-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 1.25rem;
}

.folder-title-input {
  font-family: var(--font-ui);
  font-weight: 600;
  font-size: 1.25rem;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 0;
  color: var(--text-primary);
  min-width: 0;
  max-width: 100%;
}

.folder-title-input:focus {
  outline: none;
  border-bottom-color: var(--accent);
}

.deck-card-tags {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}

.folder-tag {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  padding: 0.15rem 0.5rem;
  border-radius: 100px;
  background: var(--surface-raised);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 10rem;
}

.empty-state.compact {
  padding: 2.5rem 1.5rem;
}

.empty-state {
  border: 1px dashed var(--border-strong);
```

- [ ] **Step 5: Type-check**

Run: `npx tsc -b`
Expected: exits 0 with no output.

- [ ] **Step 6: Verify in the browser**

Run: `npm run dev` and open the printed URL. Leave the drafting mode on **Rules only**, which needs no API key. If you have no decks, create one sample file first:

```bash
printf '# Chapter 2\n\n## Cells\n\nThe cell is the basic unit of life.\n\n## Membranes\n\nThe membrane controls what enters the cell.\n' > /tmp/chapter-2.md
cp /tmp/chapter-2.md /tmp/chapter-10.md && sed -i '' 's/Chapter 2/Chapter 10/' /tmp/chapter-10.md
```

Upload both files, save each deck from the review screen, and return to the library. Then check each of these:

1. **Folder bar:** shows `All decks 2`, `Unfiled 2` and `+ New folder`. Deck cards show no folder tag.
2. **Sort:** click `A–Z`. The deck order is `chapter-2` then `chapter-10`. Click `Newest` and the newest deck is first. Choose `A–Z`, reload, and it is still selected. Tab to the switch and press ←/→: the selection moves and focus follows.
3. **Create:** click `+ New folder`, type `Biology`, and confirm. The URL becomes `/?folder=<uuid>`, the `Biology 0` chip is active, the rename input shows `Biology`, and the empty state reads "No decks in this folder yet" with an "Upload a document into Biology" button.
4. **Duplicate:** click `+ New folder` and type `  biology `. The notice "A folder named "biology" already exists." appears and no second chip is added.
5. **Rename:** change the input to `Bio 101` and press Enter. The chip updates and the URL is unchanged. Rename it to an existing folder's name (create `Chem` first) and the duplicate notice appears while the input goes back to `Bio 101`.
6. **URL:** reload on `/?folder=<uuid>` and the same folder is open. Go to `/?folder=not-a-folder` and All decks is shown. Press Back after opening a folder and the previous view returns.
7. **Delete:** open `Chem` and click Delete folder. The confirmation reads `Delete the empty folder "Chem"?`. Confirm, and the view returns to All decks with the chip gone.
8. **Narrow screen:** in DevTools, set the width to 400px with at least 6 folders. The folder bar scrolls sideways on one line and the page itself never scrolls horizontally.

- [ ] **Step 7: Commit**

```bash
git add src/lib/deckActions.ts src/routes/LibraryRoute.tsx src/components/DeckLibrary.tsx src/index.css
git commit -m "Add the library folder bar, Newest/A–Z sort switch, and folder rename and delete

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Move a deck between folders from the deck manager

**Files:**
- Modify: `src/components/DeckManager.tsx`
- Modify: `src/index.css` (the "Manager" section)

**Interfaces:**
- Consumes: `Folder` (Task 1); `UNFILED`, `folderOf`, `sortFolders` (Task 1); `getAllFolders`, `moveDeckToFolder` (Task 2).
- Produces: CSS classes `.manager-folder-row` and `.folder-select`. Task 5 reuses `.folder-select`.

- [ ] **Step 1: Import the folder helpers**

In `src/components/DeckManager.tsx`, find this exact block:

```tsx
import type { Flashcard } from "../types";
import { addCard, deleteCard, renameDeck, updateCard } from "../db/db";
import { confirmAndDeleteDeck } from "../lib/deckActions";
```

Replace it with:

```tsx
import type { Flashcard, Folder } from "../types";
import {
  addCard,
  deleteCard,
  getAllFolders,
  moveDeckToFolder,
  renameDeck,
  updateCard,
} from "../db/db";
import { confirmAndDeleteDeck } from "../lib/deckActions";
import { UNFILED, folderOf, sortFolders } from "../lib/deckFolders";
```

- [ ] **Step 2: Load folders beside the deck**

In `src/components/DeckManager.tsx`, find this exact block:

```tsx
  const [nameDraft, setNameDraft] = useState("");
  const [copied, setCopied] = useState(false);
```

Replace it with:

```tsx
  const [nameDraft, setNameDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [foldersLoaded, setFoldersLoaded] = useState(false);

  // Read here rather than through useDeck, which the study and test screens
  // share and which have no use for folders. The select stays disabled until
  // this settles, so a deck already in a folder never shows as Unfiled first.
  // A failed read leaves only Unfiled to choose; the cards stay editable.
  useEffect(() => {
    let cancelled = false;
    getAllFolders()
      .then((all) => {
        if (!cancelled) setFolders(all);
      })
      .catch((err) => {
        console.error("[manager] Could not read the folders:", err);
      })
      .finally(() => {
        if (!cancelled) setFoldersLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
```

- [ ] **Step 3: Add the move handler**

In `src/components/DeckManager.tsx`, find this exact line:

```tsx
  /** Saves a renamed deck on blur, restoring the old name if the write fails. */
```

Replace it with:

```tsx
  /**
   * Files the deck in the chosen folder, putting the select back if the write fails.
   *
   * Shown as moved straight away; the write is one small transaction, and a
   * failure is rare enough that snapping back with a notice is the better trade.
   */
  const handleFolderChange = async (value: string) => {
    if (!deck) return;
    const folderId = value === UNFILED ? null : value;
    const previous = deck;
    setDeck({ ...deck, folderId: folderId ?? undefined });
    try {
      await moveDeckToFolder(deckId, folderId);
    } catch (err) {
      console.error("[manager] Moving the deck failed:", err);
      setError("The deck could not be moved to that folder.");
      setDeck(previous);
    }
  };

  /** Saves a renamed deck on blur, restoring the old name if the write fails. */
```

- [ ] **Step 4: Render the folder select under the title**

In `src/components/DeckManager.tsx`, find this exact block:

```tsx
          <input
            className="deck-title-input"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
          />
```

Replace it with:

```tsx
          <input
            className="deck-title-input"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
          />
          <div className="manager-folder-row">
            <label htmlFor="deck-folder">Folder</label>
            {/* Always A–Z, whatever the library is sorted by: a dropdown is
                scanned for a name, not browsed by age. */}
            <select
              id="deck-folder"
              className="folder-select"
              value={folderOf(deck, new Set(folders.map((folder) => folder.id)))}
              disabled={!foldersLoaded}
              onChange={(e) => handleFolderChange(e.target.value)}
            >
              <option value={UNFILED}>Unfiled</option>
              {sortFolders(folders, "name").map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>
          </div>
```

- [ ] **Step 5: Style the select**

In `src/index.css`, find this exact block:

```css
.deck-title-input:focus {
  outline: none;
  border-bottom-color: var(--accent);
}
```

Replace it with:

```css
.deck-title-input:focus {
  outline: none;
  border-bottom-color: var(--accent);
}

.manager-folder-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.4rem 0 0.3rem;
}

.manager-folder-row label {
  font-size: 0.8rem;
  color: var(--text-secondary);
}

/* The folder picker on the manage and review screens. */
.folder-select {
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  padding: 0.4rem 0.6rem;
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: 0.9rem;
  max-width: 100%;
}

.folder-select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.folder-select:disabled {
  opacity: 0.6;
}
```

- [ ] **Step 6: Type-check**

Run: `npx tsc -b`
Expected: exits 0 with no output.

- [ ] **Step 7: Verify in the browser**

Run `npm run dev` and use the folders and decks from Task 3's check. Then check each of these:

1. Open a deck that is Unfiled. Under its name, `Folder` shows `Unfiled`, and the options are Unfiled followed by the folders A–Z.
2. Choose `Bio 101`. Go back to the library: the `Bio 101` count went up by 1, `Unfiled` went down by 1, and the card shows a `Bio 101` tag in All decks.
3. Reload the manage page. The select still shows `Bio 101`.
4. In a second tab, open the library, open `Bio 101`, and delete the folder. Back in the first tab, choose a folder that still exists and the move succeeds. To see the failure message, keep a manager tab open, delete a folder in another tab, then pick that deleted folder from the first tab's (now stale) select. The notice "The deck could not be moved to that folder." appears and the select snaps back.

- [ ] **Step 8: Commit**

```bash
git add src/components/DeckManager.tsx src/index.css
git commit -m "Let a deck be moved between folders from its manage screen

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Save a new deck into a folder, and document folders

**Files:**
- Modify: `src/routes/UploadRoute.tsx`
- Modify: `src/routes/reviewDraft.ts`
- Modify: `src/routes/ReviewRoute.tsx`
- Modify: `src/components/CandidateReview.tsx`
- Modify: `src/index.css` (next to `.review-toolbar`)
- Modify: `README.md` (new "Organising decks" section)

**Interfaces:**
- Consumes:
  - From Task 1: `Folder`, `UNFILED`, `DuplicateFolderNameError`, `cleanFolderName`, `sortFolders`.
  - From Task 2: `getAllFolders`, `createFolder`.
  - From Task 3: `/upload?folder=<id>` links from the library.
  - From Task 4: the `.folder-select` CSS class.
- Produces: `ReviewDraft.folderId?: string`; `CandidateReview` prop `folderId?: string`.

- [ ] **Step 1: Carry `?folder=` from the upload screen into the draft**

In `src/routes/reviewDraft.ts`, find this exact block:

```ts
  /** The address(es) read, for a deck built from one or more URLs. */
  sourceUrls?: string[];
}
```

Replace it with:

```ts
  /** The address(es) read, for a deck built from one or more URLs. */
  sourceUrls?: string[];
  /**
   * The folder the library had open when "New deck" was pressed. Only a hint:
   * the review screen preselects it only if a folder with this id still exists.
   */
  folderId?: string;
}
```

Replace the whole of `src/routes/UploadRoute.tsx` with:

```tsx
import { useNavigate, useSearchParams } from 'react-router-dom';
import Uploader from '../components/Uploader';
import type { ReviewDraft } from './reviewDraft';

/** Choosing a document, then handing the parsed result to the review screen. */
export default function UploadRoute() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Set when the upload started from inside a folder on the library.
  const folderId = searchParams.get('folder') ?? undefined;

  return (
    <Uploader
      onParsed={(sections, fileName, sourceType, ai, notice, sourceUrls) => {
        const draft: ReviewDraft = { sections, fileName, sourceType, ai, notice, sourceUrls, folderId };
        navigate('/review', { state: draft });
      }}
      onCancel={() => navigate('/')}
    />
  );
}
```

In `src/routes/ReviewRoute.tsx`, find this exact line:

```tsx
      sourceUrls={draft.sourceUrls}
```

Replace it with:

```tsx
      sourceUrls={draft.sourceUrls}
      folderId={draft.folderId}
```

- [ ] **Step 2: Type-check to confirm the new prop is not wired yet**

Run: `npx tsc -b`
Expected: FAIL with `Property 'folderId' does not exist on type 'IntrinsicAttributes & Props'` in `src/routes/ReviewRoute.tsx`.

- [ ] **Step 3: Accept the prop and import the folder helpers in `CandidateReview`**

In `src/components/CandidateReview.tsx`, find this exact block:

```tsx
import type { CandidateCard, Deck, Flashcard, SourceType } from '../types';
```

Replace it with:

```tsx
import type { CandidateCard, Deck, Flashcard, Folder, SourceType } from '../types';
```

Find this exact line:

```tsx
import { saveDeckWithCards } from '../db/db';
```

Replace it with:

```tsx
import { createFolder, getAllFolders, saveDeckWithCards } from '../db/db';
import { DuplicateFolderNameError, UNFILED, cleanFolderName, sortFolders } from '../lib/deckFolders';
```

Find this exact block, in `interface Props`:

```tsx
  ocrPages?: OcrPage[];
  /** Fired with the new deck's id once it is safely in the database. */
```

Replace it with:

```tsx
  ocrPages?: OcrPage[];
  /**
   * The folder to preselect, from the library view the upload started in.
   * Ignored when no folder with this id exists once the folders have loaded.
   */
  folderId?: string;
  /** Fired with the new deck's id once it is safely in the database. */
```

Find this exact block, the component's parameter list:

```tsx
  ocrPages,
  onSaved,
  onCancel,
}: Props) {
```

Replace it with:

```tsx
  ocrPages,
  folderId,
  onSaved,
  onCancel,
}: Props) {
```

- [ ] **Step 4: Add folder state, loading, and the select handler**

In `src/components/CandidateReview.tsx`, find this exact block:

```tsx
  const [deckName, setDeckName] = useState(defaultDeckName(fileName));
  const [saving, setSaving] = useState(false);
```

Replace it with:

```tsx
  const [deckName, setDeckName] = useState(defaultDeckName(fileName));
  const [saving, setSaving] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  // Unfiled until the folders load and the requested one is confirmed to exist.
  const [folderChoice, setFolderChoice] = useState<string>(UNFILED);
  const [folderError, setFolderError] = useState<string | null>(null);

  // A failed read leaves only Unfiled and "New folder…" to choose from. Saving
  // still works, so a folder problem never costs anyone their reviewed cards.
  useEffect(() => {
    let cancelled = false;
    getAllFolders()
      .then((all) => {
        if (cancelled) return;
        setFolders(all);
        if (folderId && all.some((folder) => folder.id === folderId)) {
          // Only if nothing has been picked yet, so a slow read cannot undo a choice.
          setFolderChoice((current) => (current === UNFILED ? folderId : current));
        }
      })
      .catch((err) => {
        console.error('[review] Could not read the folders:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [folderId]);

  /** Applies the folder select, creating a folder first when "New folder…" was picked. */
  const handleFolderSelect = async (value: string) => {
    setFolderError(null);
    if (value !== NEW_FOLDER) {
      setFolderChoice(value);
      return;
    }
    // The select is controlled, so cancelling leaves it on the previous choice.
    const name = prompt('Name the new folder');
    if (name === null || !cleanFolderName(name)) return;
    try {
      const folder = await createFolder(name);
      setFolders((prev) => [...prev, folder]);
      setFolderChoice(folder.id);
    } catch (err) {
      console.error('[review] Creating the folder failed:', err);
      setFolderError(
        err instanceof DuplicateFolderNameError ? err.message : 'The folder could not be created.'
      );
    }
  };
```

Then add the sentinel constant beside `UNIT_NOUN`. Find this exact block:

```tsx
/** What one parsed section is called, per source format. */
const UNIT_NOUN: Record<SourceType, string> = {
```

Replace it with:

```tsx
/** The folder select's "New folder…" option. Not a UUID, so never a real folder id. */
const NEW_FOLDER = '__new-folder__';

/** What one parsed section is called, per source format. */
const UNIT_NOUN: Record<SourceType, string> = {
```

- [ ] **Step 5: Write the chosen folder into the saved deck**

In `src/components/CandidateReview.tsx`, find this exact block inside `handleSave`:

```tsx
      sourceUrls,
      createdAt: now,
      cardCount: toSave.length,
    };
```

Replace it with:

```tsx
      sourceUrls,
      createdAt: now,
      cardCount: toSave.length,
      // Left off entirely for Unfiled, so the record matches a deck saved
      // before folders existed rather than carrying an undefined key.
      ...(folderChoice === UNFILED ? {} : { folderId: folderChoice }),
    };
```

- [ ] **Step 6: Render the select beside the deck name**

In `src/components/CandidateReview.tsx`, find this exact block:

```tsx
      <div className="deck-name-row">
        <label htmlFor="deck-name">Deck name</label>
        <input
          id="deck-name"
          type="text"
          value={deckName}
          onChange={(e) => setDeckName(e.target.value)}
          placeholder="Name this deck"
        />
      </div>
```

Replace it with:

```tsx
      <div className="deck-save-fields">
        <div className="deck-name-row">
          <label htmlFor="deck-name">Deck name</label>
          <input
            id="deck-name"
            type="text"
            value={deckName}
            onChange={(e) => setDeckName(e.target.value)}
            placeholder="Name this deck"
          />
        </div>
        <div className="deck-name-row deck-folder-row">
          <label htmlFor="deck-folder">Folder</label>
          {/* Always A–Z, whatever the library is sorted by. */}
          <select
            id="deck-folder"
            className="folder-select"
            value={folderChoice}
            onChange={(e) => handleFolderSelect(e.target.value)}
          >
            <option value={UNFILED}>Unfiled</option>
            {sortFolders(folders, 'name').map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
            <option value={NEW_FOLDER}>New folder…</option>
          </select>
          {folderError && (
            <p className="muted small" role="alert">
              {folderError}
            </p>
          )}
        </div>
      </div>
```

- [ ] **Step 7: Lay the two fields out side by side**

In `src/index.css`, find this exact block:

```css
.review-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}
```

Replace it with:

```css
/* Deck name and folder side by side, stacking once the row is too narrow. */
.deck-save-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 0 1rem;
  align-items: flex-start;
}

.deck-save-fields .deck-name-row {
  flex: 1 1 260px;
}

.deck-save-fields .deck-folder-row {
  flex: 0 1 220px;
}

/* Same height as the deck name input beside it. */
.deck-name-row .folder-select {
  padding: 0.55rem 0.75rem;
  font-size: 1rem;
}

.review-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}
```

- [ ] **Step 8: Type-check and re-run the pure tests**

Run: `npx tsc -b && node --experimental-strip-types --import ./tools/register.mjs tools/test-folders.mjs`
Expected: `tsc` exits 0, then `All checks passed.`

- [ ] **Step 9: Verify in the browser**

Run `npm run dev` and leave the drafting mode on **Rules only**. Then check each of these:

1. **Preselect:** on the library, open a folder (create `Biology` if needed) and click `+ New deck from a file`. The URL is `/upload?folder=<uuid>`. Upload `/tmp/chapter-2.md`. On the review screen, `Folder` shows `Biology`. Save. The deck manager's select shows `Biology`, and the library's `Biology` count went up.
2. **No folder:** from All decks, click `+ New deck from a file`. The URL is `/upload` and the review screen's Folder shows `Unfiled`.
3. **Unknown folder:** open `/upload?folder=not-a-folder` directly and upload a file. The review screen shows `Unfiled`.
4. **New folder while saving:** on the review screen, choose `New folder…`, type `Physics`, and confirm. The select now shows `Physics`. Save, and the deck is in `Physics` on the library.
5. **Duplicate while saving:** choose `New folder…` and type `physics`. "A folder named "physics" already exists." appears under the select, and the select still shows the previous choice.
6. **Cancel:** choose `New folder…` and cancel the prompt. The select stays on its previous choice.
7. **Narrow screen:** at 400px wide, the Folder field drops under Deck name and neither overflows the page.

- [ ] **Step 10: Document folders in the README**

In `README.md`, find this exact block:

```markdown
See [DEPLOYING.md](DEPLOYING.md) for GitHub and Netlify setup.

## How extraction works
```

Replace it with:

```markdown
See [DEPLOYING.md](DEPLOYING.md) for GitHub and Netlify setup.

## Organising decks

Decks can be filed into folders. Folders are one level deep, and a deck lives in at most one of them. A deck in none is **Unfiled**, which is where every deck saved before folders existed sits.

- **Create** a folder with **+ New folder** on the library, or with **New folder…** in the Folder menu on the review screen.
- **Save into** a folder by choosing it on the review screen. Pressing **+ New deck from a file** while a folder is open preselects that folder.
- **Move** a deck from its manage screen, with the Folder menu under its name.
- **Rename or delete** a folder by opening it on the library. Deleting a folder never deletes decks; they move to Unfiled.

The **Newest / A–Z** switch sorts both the folders and the decks, and is remembered in this browser. A–Z ignores case and reads numbers as numbers, so "Chapter 2" comes before "Chapter 10". The folder a library view shows is in its address (`/?folder=…`), so reloading or going Back keeps it. The Folder menus on the review and manage screens always list folders A–Z.

## How extraction works
```

- [ ] **Step 11: Commit**

```bash
git add src/routes/UploadRoute.tsx src/routes/reviewDraft.ts src/routes/ReviewRoute.tsx src/components/CandidateReview.tsx src/index.css README.md
git commit -m "Save new decks into a folder from the review screen, and document deck folders

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Spec coverage

| Spec requirement | Task |
|---|---|
| `Folder` type, `Deck.folderId`, absent key means Unfiled | 1 (types), 2 (writes remove the key), 5 (save leaves it off) |
| `folderOf` treats an unknown folder as Unfiled | 1 |
| DB v3 upgrade, `folders` store, no `by-folderId` index | 2 |
| `getAllFolders` / `createFolder` / `renameFolder` / `deleteFolder` / `moveDeckToFolder`, one transaction each | 2 |
| Case-insensitive unique, trimmed, non-empty names with a named error | 1 (rules), 2 (enforced), 3 and 5 (messages) |
| Deleting a folder unfiles its decks | 2 (storage), 3 (confirmation wording) |
| `countDecksByFolder`, `filterDecks`, `parseFolderFilter` | 1 |
| Folder bar: All first, Unfiled last, `+ New folder`, sideways scroll, `?folder=` | 3 |
| Rename (inline, saved on blur) and delete of the open folder | 3 |
| Folder tag on deck cards only in All decks | 3 |
| Empty folder state that links to upload with the folder preselected | 3 (link), 5 (preselect) |
| Newest / A–Z switch for folders and decks in every view; numeric, case-insensitive; ties newest first | 1 (sorting), 3 (switch) |
| Sort remembered in `localStorage` under `flashcard-forge:library-sort` | 1 |
| `radiogroup` with arrow keys | 3 |
| Review screen folder select with `New folder…`; a failed folder load doesn't block saving | 5 |
| Deck manager folder select; a failed move reverts with a notice | 4 |
| Selects always A–Z | 4, 5 |
| Tests: `tools/test-folders.mjs`, plus four new `idb-check.html` cases | 1, 2 |
| README | 1 (test command), 5 (Organising decks) |
