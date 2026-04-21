/**
 * Returns the index of the first code unit at which `next` diverges from
 * `prev`. If `next` is a prefix of `prev` or vice versa, returns the length
 * of the shorter string. When combined with `next.slice(offset)`, the result
 * describes a minimal patch for mutating `prev` into `next`:
 *
 *   result = prev.slice(0, offset) + next.slice(offset)
 */
export function firstDivergingIndex(prev: string, next: string): number {
  const min = Math.min(prev.length, next.length);
  for (let i = 0; i < min; i++) {
    if (prev.charCodeAt(i) !== next.charCodeAt(i)) {
      return i;
    }
  }
  return min;
}
