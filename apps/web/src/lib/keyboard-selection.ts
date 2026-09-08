/**
 * Cyclic highlight movement over a list of `length` rows. A `null` current index
 * means "no highlight" — arrowing into it lands on the first row (down) or last
 * row (up).
 *
 * This lives here rather than in `hooks/useKeyboardSelection.ts` because both the
 * hook (which owns the highlight for command/select/review screens) and the pure
 * path-interaction policy in `lib/palette/path-step.ts` (whose highlight is owned
 * by the palette machine) move a highlight the same way. The hook re-exports it,
 * so existing importers are unaffected.
 */
export function moveIndex(current: number | null, delta: number, length: number): number | null {
  if (length === 0) return null;
  if (current === null) return delta < 0 ? length - 1 : 0;
  return (current + delta + length) % length;
}
