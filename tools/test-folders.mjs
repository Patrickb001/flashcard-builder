import { getStoredLibrarySort, storeLibrarySort } from '../src/lib/librarySort.ts';
import {
  UNFILED,
  cleanFolderName,
  countDecksByFolder,
  deleteFolderModalCopy,
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

console.log('\nDELETE-FOLDER MODAL COPY');
check(
  'an empty folder says there is nothing to move',
  deleteFolderModalCopy('Chem', 0),
  { title: 'Delete "Chem"?', body: 'This folder is empty — there is nothing to move.' }
);
check(
  'one deck reads as singular',
  deleteFolderModalCopy('Chem', 1),
  { title: 'Delete "Chem"?', body: 'Its 1 deck will move to Unfiled. No decks are deleted.' }
);
check(
  'more than one deck reads as plural',
  deleteFolderModalCopy('Chem', 3),
  { title: 'Delete "Chem"?', body: 'Its 3 decks will move to Unfiled. No decks are deleted.' }
);

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
