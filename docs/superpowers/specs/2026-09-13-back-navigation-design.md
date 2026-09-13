# Back Navigation — Design

**Goal:** The top bar's "Back to library" button (`src/App.tsx`) always sends you to `/`, the unfiltered shelf — even from Study or Manage, even if you opened them from inside a folder. Make it return to whatever screen you were actually on before, so leaving a folder's Study or Manage screen puts you back in that folder rather than dumping you at the top of the whole library.

**Scope in one line:** change what the existing top-bar button does and when it shows; nothing else. No new button, no change to the deck card actions row (already shipped separately), no change to the other "Back to library" buttons already living inside specific screens.

## Decisions (all confirmed 2026-09-13)

| Question | Decision | Why |
|---|---|---|
| Where the fix lives | The **existing** top-bar button in `App.tsx`'s `.top-bar-actions`, not a new button on the deck manager screen | A first attempt added a second "Back to library" control directly on the Manage screen. It duplicated the top bar's own button — both visible at once, both labelled the same, one of them stale. Fixing the one control that already exists on every screen is simpler and removes the duplication. |
| What "back" means | The **actual previous in-app page** — plain browser/router history (`navigate(-1)`), not a folder id threaded through query params | Covers every screen the same way (Study, Manage, Test, and anything added later) without each route having to know it's part of a "return to my folder" scheme. A `?folder=` query-param relay was prototyped for this and reverted: history already carries that same information for free, since the previous URL (`/?folder=biology`) is exactly what `navigate(-1)` returns to. |
| No history to go back to (a deck link opened directly, or a reload while on Study/Manage/Test) | **Hide the button** rather than falling back to `/` | Falling back to `/` would make the button lie some of the time — it would say "Back" but actually mean "home." Hiding it when there is nothing to go back to keeps its one meaning always true. |
| The other "Back to library" buttons (Study's empty-deck and deck-complete states, the Test setup screen) | **Left exactly as they are** — still an unconditional `navigate('/')`, wired through each route's `onExit` prop | These are a different affordance: a deliberate "I'm done, take me to the shelf" action at a natural stopping point, not a "take me back" control. Only the top bar's button changes. |
| Telling "back" from "forward" | Compare the browser history index (`window.history.state.idx`, set by react-router-dom's own `createBrowserHistory`) against the index recorded when the app mounted, rather than counting `POP`/`PUSH` events | A plain "did we go forward or back" counter can't tell a `POP` from the browser's native Back button apart from one triggered by its native Forward button — both fire as `POP`. Comparing index-to-a-fixed-mount-baseline is exact in both directions, confirmed empirically (see Verification). |
| Whether that baseline should survive a page reload | **No** — it resets on every mount | `window.history.state.idx` itself survives a reload (confirmed empirically), but the *app* doesn't remember what was actually on the previous page after a reload wipes its in-memory state. Re-reading the current index as the new baseline on every fresh mount means a reload always starts with nothing to go back to, matching the "hide it when we don't really know" rule above. |
| Button label | **"Back"**, not "Back to library" | The destination is now whatever the previous screen was — which often isn't the library at all (e.g. Test → Manage). Keeping the old label would describe the wrong destination most of the time. |

## Mechanism

React Router's browser history (the implementation behind `createBrowserRouter`) keeps `{ key, idx }` in `window.history.state` for the current entry: `idx` starts at `0` for the entry the browser is currently on, `+1` for every further **push**, unchanged on a **replace**, and follows the browser natively on **back/forward** (a "forward" always lands on a strictly higher `idx` than a "back"). This was confirmed directly against the running app (`playwright`, not assumed):

```
fresh load at /                      -> { idx: 0 }
in-app push to /upload               -> { idx: 1 }
in-app push back to /                -> { idx: 2 }
in-app push to /upload again         -> { idx: 3 }
native goBack()                      -> { idx: 2 }
native goForward()                   -> { idx: 3 }
reload() while still on /upload      -> { idx: 3 }   <- survives the reload
```

So: record `idx` once, in a ref, the moment `App` mounts (`mountIdx`). On every render (which happens on every navigation, since `App` reads `useLocation()`), compare the **current** `idx` to `mountIdx`. Back is available exactly when `currentIdx > mountIdx`.

```ts
// src/lib/navigationHistory.ts
export function canNavigateBack(mountIdx: number, currentIdx: number): boolean {
  return currentIdx > mountIdx;
}
```

`App.tsx` reads `window.history.state` itself (there is nowhere else to read it from) and calls this pure function to decide whether to render the button:

```tsx
function currentHistoryIdx(): number {
  const state = window.history.state as { idx?: number } | null;
  return state?.idx ?? 0;
}

// inside App():
const mountIdxRef = useRef(currentHistoryIdx());
const canGoBack = canNavigateBack(mountIdxRef.current, currentHistoryIdx());
```

The button:

```tsx
{!atLibrary && canGoBack && (
  <button className="ghost-btn" onClick={() => navigate(-1)}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 6l-6 6 6 6" />
    </svg>
    Back
  </button>
)}
```

`atLibrary` (`pathname === '/'`) is kept as an additional gate exactly as it works today: the button never shows while already at the library, regardless of history.

## What does not change

- `src/components/StudyMode.tsx`, `src/components/quiz/QuizSetup.tsx`: their own "Back to library" buttons keep calling the `onExit` prop they already take, which every route still wires to a plain `navigate('/')`. Not touched.
- `src/routes/*.tsx`: no route needs to know about the previous page. No `?folder=` query threading — that was built, tested, and reverted during this feature's own exploration, in favor of the plain history mechanism above.
- The deck card action buttons (Study / Manage cards / Remove from folder) restyle: separate, already shipped, unaffected by this change.

## Verification

- `canNavigateBack` is a pure function — covered by a `tools/test-*.mjs` script in the project's existing style (see `tools/test-folders.mjs` for the pattern: a `check(label, actual, expected)` helper, run with `node --experimental-strip-types --import ./tools/register.mjs`).
- The button's actual behavior in the browser (mount-time baseline, hide/show across pushes, native back/forward, and hiding again after a reload) has no automated harness in this repo (there is no headless-browser test runner configured) and is checked manually against the running dev server, the same way `tools/idb-check.html` and `tools/screen-failure-check.html` document manual browser checks for behavior IndexedDB/browser-only code can't get from the plain-Node test scripts.
