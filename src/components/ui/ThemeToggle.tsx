import { useState } from 'react';
import { applyTheme, currentTheme, type Theme } from '../../lib/theme';

/**
 * Light/dark segmented control for the top bar.
 *
 * Reads the theme the inline head script already stamped on `<html>` rather
 * than resolving it again, so this never disagrees with what is on screen.
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  const choose = (next: Theme) => {
    applyTheme(next);
    setTheme(next);
  };

  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Theme">
      <button
        type="button"
        role="radio"
        aria-checked={theme === 'light'}
        className={theme === 'light' ? 'active' : ''}
        onClick={() => choose('light')}
        title="Light mode"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={theme === 'dark'}
        className={theme === 'dark' ? 'active' : ''}
        onClick={() => choose('dark')}
        title="Dark mode"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
        </svg>
      </button>
    </div>
  );
}
