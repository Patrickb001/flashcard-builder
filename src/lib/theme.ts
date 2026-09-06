export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'flashcard-forge:theme';

/** The theme last chosen through the toggle, or null if never set (or unreadable). */
export function getStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    // Storage can be unavailable in a locked-down browsing context.
    return null;
  }
}

/**
 * The theme to open with: an explicit past choice wins, otherwise the OS
 * preference, otherwise light. Kept in step with the inline script in
 * index.html, which resolves the same way before this module ever loads.
 */
export function resolveInitialTheme(): Theme {
  const stored = getStoredTheme();
  if (stored) return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Applies a theme to the document and remembers it for next time. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Not persisted this session, but still applied — losing the preference
    // is not worth failing the toggle over.
  }
}

/** The theme currently stamped on the document, read back for the toggle's own state. */
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}
