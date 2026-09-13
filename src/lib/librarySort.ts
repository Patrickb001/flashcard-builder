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
