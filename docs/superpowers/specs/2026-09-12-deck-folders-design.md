 # Deck Folders — Design

**Goal:** Let decks be filed into folders so the library stays navigable once it holds more than a screenful of decks. Today `getAllDecks()` returns one flat, newest-first list and `DeckLibrary.tsx` renders it as one grid, so there is no grouping at all: ten decks from the same course sit mixed in with everything else.

**Scope in one line:** flat folders (one level), each deck in at most one folder or in none ("Unfiled"). A folder is only a way to organise decks. Studying, testing, exporting and card editing work exactly as they do now.

## Decisions (all confirmed 2026-09-12)

| Question | Decision | Why |
|---|---|---|
| Nesting | **Flat**: folders cannot contain folders | Covers "one folder per course/exam" without needing a tree UI, breadcrumbs, or recursive deletes. Can be added later without changing how decks are stored (a folder could gain `parentId`). |
| Decks per folder | **At most one folder per deck** | A folder is where a deck lives. Putting one deck in several places is tagging, which is a different feature. |
| Where the link is stored | **`Deck.folderId?: string`**, not a list of deck ids on the folder | One source of truth. Moving a deck writes one record, and deleting a deck never has to touch a folder. |
| Deleting a folder | **Its decks become Unfiled.** They are not deleted. | Deleting a deck already cannot be undone and asks for confirmation. Removing a folder should never be a hidden way to wipe out many decks at once. |
| Choosing a folder | On the **review screen at save time**, and on the **deck manager** afterwards | These are the two places a deck's name is already edited, so its folder sits next to its name. |
| Current folder view | Kept in the URL as **`/?folder=<id>`** (`/?folder=unfiled` for decks with no folder) | Back, reload and shared links all keep the view. This matches how the router already puts ids in the URL. |
| Library sort order | A **Newest / A–Z** switch on the library, applied to both the folder bar and the deck grid. Newest is the default. | Replaces a fixed order that looked arbitrary. One switch for both lists is easier to predict than two separate settings. |
| Remembering the sort | Saved in **`localStorage`** under `flashcard-forge:library-sort`, not in the URL | It's a lasting personal preference, like the theme, not a view you'd share. Saving it in the URL would lose it whenever you return to `/` from another screen. |

## Data model

`src/types.ts`:

```ts
/** A named group of decks. Holds no deck ids; decks point at it. */
export interface Folder {
  id: string;
  name: string;
  createdAt: number;
}

export interface Deck {
  // ...existing fields...
  /**
   * The folder this deck is filed in. Absent means Unfiled. That includes
   * every deck saved before folders existed, so no migration is needed, the
   * same approach as `Flashcard.order` and `TestQuestion.style`.
   */
  folderId?: string;
}
```

A deck can point at a folder that no longer exists, for example when another tab deleted the folder a moment earlier. **Treat an unknown `folderId` as Unfiled when reading**, through a single helper (`folderOf`, see below) and never by reading `deck.folderId` directly. This is the same rule `styleOf` enforces for questions.

## Storage: `src/db/db.ts`

- `DB_VERSION` goes from 2 to 3. Add an `if (oldVersion < 3)` block that creates a `folders` store (`keyPath: 'id'`). **Existing stores are not changed and no data is migrated.** The guard is required: without it the upgrade throws for every existing user (see the comment on `upgrade`).
- **No `by-folderId` index on `decks`.** The library already loads every deck, so grouping them in memory costs nothing. An index would also leave out the Unfiled decks, since IndexedDB does not index records whose key is `undefined`.
- New functions, each using one transaction, following the patterns already in the file:

```ts
getAllFolders(): Promise<Folder[]>                        // unordered; callers sort with sortFolders
createFolder(name: string): Promise<Folder>               // throws DuplicateFolderNameError
renameFolder(folderId: string, name: string): Promise<void>   // read+write in one tx, like renameDeck
deleteFolder(folderId: string): Promise<void>             // folders+decks tx: delete folder, clear folderId on its decks
moveDeckToFolder(deckId: string, folderId: string | null): Promise<void>  // read+write in one tx
```

- `moveDeckToFolder` must read and write the deck inside one transaction, **for the same reason `renameDeck` does**: if the read and write are separate, a `cardCount` change made by `addCard` in between gets overwritten.
- `deleteFolder` walks `decks` with a cursor and clears `folderId` on matching decks in the same transaction as the folder delete. A folder therefore never disappears while decks still point at it, unless another tab is involved, which `folderOf` handles.
- **Folder names are unique, compared case-insensitively after trimming.** `createFolder` and `renameFolder` check inside their transaction and throw a named error, so the UI can say "A folder with that name already exists" instead of showing a generic failure. An empty name is rejected.
- `saveDeckWithCards` is unchanged. `folderId` is just another field on the `Deck` it already writes.
- `deleteDeck` is unchanged, because folders do not store deck ids.

## Grouping and sorting logic: `src/lib/deckFolders.ts` (new, pure)

This is kept separate from React and IndexedDB so it can be tested under plain Node like the other `tools/test-*.mjs` scripts:

```ts
export const UNFILED = 'unfiled';
export type FolderFilter = 'all' | typeof UNFILED | string;   // string = a folder id

/** The folder a deck is really in: its folderId if that folder exists, else UNFILED. */
export function folderOf(deck: Deck, folderIds: ReadonlySet<string>): string;

/** Deck counts per folder id plus UNFILED, for the folder list. */
export function countDecksByFolder(decks: Deck[], folders: Folder[]): Map<string, number>;

/** Decks matching a filter, keeping the incoming (newest-first) order. */
export function filterDecks(decks: Deck[], folders: Folder[], filter: FolderFilter): Deck[];

/** Parses ?folder=; an unknown id falls back to 'all' rather than showing an empty shelf. */
export function parseFolderFilter(param: string | null, folders: Folder[]): FolderFilter;

export type LibrarySort = 'newest' | 'name';

/** A new array; the input is not changed. */
export function sortDecks(decks: Deck[], sort: LibrarySort): Deck[];
export function sortFolders(folders: Folder[], sort: LibrarySort): Folder[];
```

**What each sort means:**
- **`newest`:** `createdAt` descending. This is today's deck order, now applied to folders as well.
- **`name`:** compares with one shared `Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`. That makes it ignore case and accents, and puts numbers in natural order, so "Chapter 2" comes before "Chapter 10". A plain `localeCompare` would put "Chapter 10" first, which is exactly the kind of order that looks random. Names that compare equal fall back to newest first, so the order never depends on how IndexedDB happened to return the records.

`getAllDecks()` still returns newest first, because the `by-createdAt` index gives that order for free. All sorting happens in these helpers after filtering, so `db.ts` doesn't need to know about sorting.

**Saving the preference:** `src/lib/librarySort.ts` is a small module that follows the same pattern as `theme.ts`. `getStoredLibrarySort(): LibrarySort` returns `'newest'` when the stored value is missing, unreadable, or not one it recognises, and `storeLibrarySort(sort)` saves the choice. Both catch storage errors, so a browser that blocks storage still sorts correctly; the choice just isn't remembered.

## UI

### Library (`LibraryRoute.tsx`, `DeckLibrary.tsx`)

- `LibraryRoute` loads decks and folders in parallel and passes both down. The existing `loading`/`error`/upgrade-blocked handling covers both reads. (A blocked upgrade is more likely now, since this change bumps the version.)
- **Folder bar** above the grid: `All decks (n)` · each folder `(n)` · `Unfiled (n)` · `+ New folder`. On narrow screens it scrolls horizontally instead of wrapping to several lines. The selected entry comes from `?folder=` and is changed with `setSearchParams`. `All decks` always comes first and `Unfiled` always comes last; only the real folders between them are sorted.
- **Sort switch:** a two-option segmented control (`Newest` | `A–Z`) at the right end of the library header row. It sits in the header rather than the folder bar, which scrolls on narrow screens and could push the switch out of view. It applies in every view (All decks, a single folder, Unfiled), so the decks inside a folder are sorted too. It is a `role="radiogroup"` so keyboard and screen-reader users get the usual arrow-key behaviour. `DeckLibrary` owns this state: it starts from `getStoredLibrarySort()`, saves every change with `storeLibrarySort`, and displays `sortFolders(folders, sort)` and `sortDecks(filterDecks(...), sort)`. Changing the sort never reloads data from the database.
- A **selected folder** shows actions to rename it (inline input, saved on blur, like the deck title) and delete it (confirm, then decks become Unfiled). Put the confirm wording in `deckActions.ts` as `confirmAndDeleteFolder`, for the reason given in that file's comment on `confirmAndDeleteDeck`.
- **Deck cards** show a small folder label only in the `All decks` view. Inside a folder the label would just repeat the folder name.
- **Empty states:** an empty folder says "No decks in this folder yet" and links to the upload screen with that folder preselected. The current first-visit empty state stays as it is when there are no decks at all.
- `+ New deck from a file` goes to `/upload?folder=<id>` when a real folder is selected, so the new deck lands in the folder the user was viewing.

### Upload → Review (`UploadRoute.tsx`, `reviewDraft.ts`, `CandidateReview.tsx`)

- `ReviewDraft` gains `folderId?: string`, filled from `/upload`'s `?folder=` param. This is a small string, so it can travel in history state; the size limits that led OCR images into `ocrPageHandoff.ts` do not apply to it.
- `CandidateReview` shows a **Folder** `<select>` beside the existing "Deck name" field. Its options are `Unfiled`, every folder, and `New folder…`. The folders are always listed A–Z (`sortFolders(folders, 'name')`), whatever the library is set to, because a dropdown is scanned for a name. Choosing `New folder…` asks for a name, calls `createFolder`, and selects the new folder. The chosen id is written into the `Deck` built in `handleSave`.
- The folder list is loaded when the review screen mounts. If that load fails, the select shows only `Unfiled`. Saving the deck still works, so a folder problem never costs the user their reviewed cards.

### Deck manager (`DeckManager.tsx`)

- A **Folder** `<select>` under the title input (options: `Unfiled` plus every folder, always listed A–Z, as on the review screen). A change calls `moveDeckToFolder` right away. If that fails, it reverts and reports through the existing `ErrorNotice` slot, the same way `commitName` handles a failed rename.

## Non-goals

- Nested folders, tags, or one deck in several folders.
- Drag-and-drop between folders.
- A "Move to…" menu on library deck cards. Decks are moved from the deck manager's folder select; a menu on the cards can be added later if that turns out to be too slow.
- Studying, testing, or exporting a whole folder as one set of cards.
- Sort orders beyond Newest and A–Z (such as oldest, card count, or recently studied), separate sorts for folders and decks, or dragging items into a custom order.
- Bulk-moving several decks at once.

## Testing

- **`tools/test-folders.mjs`** (Node, `--import ./tools/register.mjs`): `folderOf` with a missing folder, counts including Unfiled, each filter, and `parseFolderFilter` with unknown/empty/`unfiled` values. Sorting cases:
  - `name` sorts "Chapter 2" before "Chapter 10".
  - `name` treats "biology" and "Biology" as equal and orders them newest first.
  - `newest` sorts by `createdAt` descending.
  - Neither sort changes its input array.
  - `getStoredLibrarySort` falls back to `'newest'` for a missing or unrecognised value. This needs a stubbed `localStorage` in Node.
- **`tools/idb-check.html`** (real browser, same collector setup), new cases:
  1. **Upgrade from v2:** create a raw v2 database with decks, cards and questions using the plain IndexedDB API, then open it through `db.ts`. Every record should still read back and `folders` should exist.
  2. `deleteFolder` clears `folderId` on that folder's decks and leaves other folders' decks alone.
  3. `moveDeckToFolder` running at the same time as several `addCard` calls does not lose any `cardCount` increments. This mirrors the existing race test.
  4. A duplicate name, differing only in case or surrounding spaces, is rejected by both `createFolder` and `renameFolder`.
- **Manual in the browser:** create, rename and delete a folder; save a new deck into a folder from the review screen; move a deck from the manager; reload on `/?folder=<id>`; open the app in two tabs to confirm the upgrade-blocked message still shows.

## Implementation outline

Each step leaves `npx tsc -b` passing:

1. **Types + storage:** `Folder`, `Deck.folderId`, the DB v3 upgrade, the five folder functions, and the new `idb-check.html` cases.
2. **Grouping and sorting helpers:** `deckFolders.ts` (including `sortDecks`/`sortFolders`), `librarySort.ts`, and `tools/test-folders.mjs`.
3. **Library folder bar + sort switch:** filter via `?folder=`, the Newest/A–Z switch with its saved preference, create/rename/delete, and `confirmAndDeleteFolder`.
4. **Deck manager:** the folder select.
5. **Save into a folder:** `?folder=` on upload, then `ReviewDraft.folderId`, then the select on the review screen.
6. **Docs + styles:** README library section, plus CSS for the folder bar in `index.css` (including the narrow-screen scroll).
