/**
 * Fisher-Yates, on a copy.
 *
 * Shared rather than copied because study order and test order have to agree
 * on what "random" means: a second, subtly different shuffle in the quiz code
 * would be a place for bias to creep into which questions get asked.
 */
export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
