/**
 * Keyboard steps for the inspector's lists and its tab strip.
 *
 * Only the vertical step is shared. Left and Right mean something different in every widget —
 * expand and collapse in Trace, nothing in Checkpoints, the next tab in the tab strip —
 * so each widget keeps its own, and `null` for a key a step does not own lets the caller fall
 * through to it.
 */

/**
 * The index a vertical list moves to for `key`, or `null` when the key is not Up/Down/Home/End.
 *
 * `index` is -1 when nothing is selected; Up and Down then both land on the first item, since there
 * is no position to move from. An empty list goes nowhere (`null`), so the caller does nothing.
 */
export function verticalIndex(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return index < 0 ? 0 : Math.min(count - 1, index + 1);
    case 'ArrowUp':
      return index < 0 ? 0 : Math.max(0, index - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * The tab strip's own step: Left and Right wrap, Home and End go to the ends.
 *
 * Not a general horizontal step. It belongs to the inspector's tablist, where wrapping is what
 * WAI-ARIA asks of a tab row and would be wrong for a list.
 */
export function tabStep(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
