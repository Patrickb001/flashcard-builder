# Back Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the top bar's "Back" button (today: "Back to library", `src/App.tsx`) return to whatever screen was actually open before — Study, Manage, Test, a specific folder view — instead of always jumping to the unfiltered library shelf, and hide it entirely when there is no in-app previous page to return to.

**Architecture:** One pure helper, `canNavigateBack(mountIdx, currentIdx)`, decides whether "back" is possible by comparing the browser history index at the moment the app mounted to the current one (`window.history.state.idx`, set by react-router-dom's own history implementation). `App.tsx` reads that index, keeps the mount-time baseline in a `ref`, and swaps its existing unconditional `navigate('/')` button for one that calls `navigate(-1)` and only renders when the helper says there's somewhere to go back to.

**Tech Stack:** TypeScript, React 18, React Router 7 (`useNavigate`, `useLocation`, browser history), Vite. The pure helper is tested with Node 22 (`--experimental-strip-types`), matching every other `src/lib/*.ts` module in this repo; the in-browser behavior (mount baseline, native back/forward, reload) is checked against the running dev server, since this repo has no headless-browser test runner — the same way `tools/idb-check.html` documents a manual check for behavior the plain-Node scripts can't reach.

**Spec:** `docs/superpowers/specs/2026-09-13-back-navigation-design.md`

## Global Constraints

- Only `src/App.tsx` changes navigation behavior. Do not touch `src/routes/*.tsx`, `src/components/StudyMode.tsx`, or `src/components/quiz/QuizSetup.tsx` — their `onExit`/`onManageExit` props keep working exactly as they do today (an unconditional `navigate('/')` or `navigate(\`/deck/${id}\`)`), per the spec's "What does not change" section.
- No `?folder=` or other query-param relaying between routes. The previous attempt at this threaded a folder id through every route (`LibraryRoute`, `DeckRoute`, `StudyRoute`, `TestRoute`) and was reverted — plain browser history already carries the same information.
- The new pure logic lives in `src/lib/navigationHistory.ts`, matching `src/lib/deckFolders.ts`'s existing style since it lives in the same directory: single quotes, semicolons, one blank line between exports.
- `src/lib/navigationHistory.ts` must be loadable by `node --experimental-strip-types` the same as every other `src/lib/*.ts` file — no `enum`, no `namespace`, no constructor-parameter properties, no import that isn't type-only or from another such file.
- `App.tsx` uses single quotes today (`useLocation`, `'/'`, etc.) — keep matching that.
- The button's visible label is exactly `Back` (not `Back to library`), per the spec.
- No new `dependencies` or `devDependencies`.
- Commit messages: a sentence-case description, no `feat:` prefix, ending with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- Work happens on the current branch, `AddBackButton` — this repo's convention (see `docs/superpowers/plans/2026-09-12-deck-folders.md`) is a feature branch or worktree, and that branch already exists and is checked out for this work.

---

### Task 1: `canNavigateBack` pure helper

**Files:**
- Create: `src/lib/navigationHistory.ts`
- Create: `tools/test-navigation-history.mjs`

**Interfaces:**
- Consumes: nothing (pure, no imports).
- Produces: `canNavigateBack(mountIdx: number, currentIdx: number): boolean` — `true` exactly when `currentIdx > mountIdx`. Task 2 imports this from `../lib/navigationHistory`.

- [ ] **Step 1: Write the failing test**

Create `tools/test-navigation-history.mjs`:

```js
import { canNavigateBack } from '../src/lib/navigationHistory.ts';

/**
 * Whether the top bar's Back button has an in-app page to return to.
 *
 *   node --experimental-strip-types --import ./tools/register.mjs tools/test-navigation-history.mjs
 *
 * Pure — no browser, no React Router. The real `window.history.state.idx`
 * this is fed in the browser is checked by hand against the dev server; see
 * the spec's Verification section for the empirical trace that shape came from.
 */

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — got ${actual}, wanted ${expected}`}`);
}

console.log('canNavigateBack');
// Fresh mount, nothing navigated yet: idx equals the mount baseline.
check('at the mount point itself', canNavigateBack(0, 0), false);
check('one push past the mount point', canNavigateBack(0, 1), true);
check('several pushes past the mount point', canNavigateBack(2, 5), true);
// A reload re-baselines to the current idx, even if the browser's own idx is high.
check('freshly reloaded at a high idx (new baseline == current)', canNavigateBack(7, 7), false);
// Native back below the mount point should not happen in practice (idx cannot
// go below where this app instance started), but the comparison stays exact
// rather than clamping, since a wrong assumption here should show up as a
// visible test failure, not a silently "clamped" pass.
check('current below mount point', canNavigateBack(3, 1), false);

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-navigation-history.mjs`
Expected: fails to even run — `src/lib/navigationHistory.ts` does not exist yet (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/navigationHistory.ts`:

```ts
/**
 * Whether the app has an in-app page to go back to.
 *
 * `currentIdx` is the browser history index right now; `mountIdx` is what
 * that index was the moment this page instance first loaded. A fresh page
 * load or reload always starts even with its own mount point — even though
 * the browser's own history index can be high from earlier in the session —
 * so Back only offers to go somewhere this instance actually knows about.
 */
export function canNavigateBack(mountIdx: number, currentIdx: number): boolean {
  return currentIdx > mountIdx;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --import ./tools/register.mjs tools/test-navigation-history.mjs`
Expected: every line prints `ok`, then `All passed.`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/navigationHistory.ts tools/test-navigation-history.mjs
git commit -m "$(cat <<'EOF'
Add canNavigateBack, the pure history-index check the top bar's Back button will use

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire the top bar's Back button to history

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `canNavigateBack` from `./lib/navigationHistory` (Task 1).
- Produces: nothing new for other files — `App.tsx` is the app's root layout and nothing imports from it.

- [ ] **Step 1: Read the current button before changing it**

Open `src/App.tsx`. The relevant block today:

```tsx
import { Suspense } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import RouteFallback from './components/RouteFallback';
import ThemeToggle from './components/ui/ThemeToggle';

export default function App() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const atLibrary = pathname === '/';

  return (
    <div className="app-shell">
      <header className="top-bar">
        <button className="brand" onClick={() => navigate('/')}>
          {/* ...brand mark... */}
        </button>
        <div className="top-bar-actions">
          {!atLibrary && (
            <button className="ghost-btn" onClick={() => navigate('/')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 6l-6 6 6 6" />
              </svg>
              Back to library
            </button>
          )}
          <ThemeToggle />
        </div>
      </header>
      {/* ...Suspense/Outlet... */}
    </div>
  );
}
```

There is no test to make fail first here — this step swaps one component's render logic and is verified by driving the real app (Step 3), not by a unit test. (`canNavigateBack` itself was already test-driven in Task 1.)

- [ ] **Step 2: Make the change**

Add the `useRef` import, the `canNavigateBack` import, and a small local helper for reading the browser's history index; replace the button's condition, destination, and label:

```tsx
import { Suspense, useRef } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import RouteFallback from './components/RouteFallback';
import ThemeToggle from './components/ui/ThemeToggle';
import { canNavigateBack } from './lib/navigationHistory';

/** The browser's own history-entry index for right now, or 0 if react-router-dom's history hasn't set one yet (there is always one once the router has rendered once, but this keeps the read total). */
function currentHistoryIdx(): number {
  const state = window.history.state as { idx?: number } | null;
  return state?.idx ?? 0;
}

export default function App() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const atLibrary = pathname === '/';
  // The history index as of this page load. A fresh load or reload always
  // starts even with its own baseline, so Back only offers a page this
  // instance actually navigated to itself — see the design doc's
  // Verification section for why this can't just read the browser's raw
  // index on its own.
  const mountIdxRef = useRef(currentHistoryIdx());
  const canGoBack = canNavigateBack(mountIdxRef.current, currentHistoryIdx());

  return (
    <div className="app-shell">
      <header className="top-bar">
        <button className="brand" onClick={() => navigate('/')}>
          {/* ...brand mark... (unchanged) */}
        </button>
        <div className="top-bar-actions">
          {!atLibrary && canGoBack && (
            <button className="ghost-btn" onClick={() => navigate(-1)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 6l-6 6 6 6" />
              </svg>
              Back
            </button>
          )}
          <ThemeToggle />
        </div>
      </header>
      {/* ...Suspense/Outlet... (unchanged) */}
    </div>
  );
}
```

Keep the brand mark SVG, the `Suspense`/`Outlet` block, and every other line exactly as they are today — only the imports, the two new lines above the `return`, and the one button change.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 4: Verify against the running app**

Start the dev server if it isn't already running:

```bash
npm run dev -- --port 5173 &
for i in $(seq 1 30); do curl -sf http://localhost:5173 >/dev/null && echo UP && break; sleep 1; done
```

Then, with a real browser (or a scripted one — this repo has no `chromium-cli`/Playwright test setup checked in, so drive it ad hoc the way this feature's own design work already did), confirm all of these, matching the empirical trace in the spec:

1. **Fresh load at `/`:** no Back button (the `atLibrary` gate alone already hid it; confirm it still does).
2. **Fresh load directly on a deep link** (e.g. open `/deck/<some-id>` as the first request in a new browser context, not by clicking into it): no Back button — `canGoBack` is `false` because `mountIdxRef.current === currentHistoryIdx()`.
3. **Click into the library, then into Manage** (or Study, or Test): Back button appears. Click it: lands back on the exact previous library view (including its `?folder=` if one was open), not `/`.
4. **Drill two levels deep** (e.g. library → Manage → Study): Back once returns to Manage, not the library; Back again returns to the library.
5. **Use the browser's own native Back/Forward buttons** instead of the in-app one at each step above: the in-app Back button's visibility stays correct either way (it isn't only reacting to its own clicks).
6. **Reload the page while on Study or Manage:** Back button disappears, even though it was visible right before the reload.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "$(cat <<'EOF'
Make the top bar's Back button return to the previous in-app page instead of always the library

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
