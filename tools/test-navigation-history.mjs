import { canNavigateBack } from '../src/lib/navigationHistory.ts';

/**
 * Whether the top bar's Back button has an in-app page to return to.
 *
 *   node --experimental-strip-types --import ./tools/register.mjs tools/test-navigation-history.mjs
 *
 * Pure — no browser, no React Router. The real `window.history.state.idx`
 * this is fed in the browser is checked by hand against the dev server; see
 * the spec's Mechanism section for the empirical trace that shape came from.
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
