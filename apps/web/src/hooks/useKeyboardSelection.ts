import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * Cyclic highlight movement over a list of `length` rows. A `null` current index
 * means "no highlight" — arrowing into it lands on the first row (down) or last
 * row (up).
 */
export function moveIndex(current: number | null, delta: number, length: number): number | null {
  if (length === 0) return null;
  if (current === null) return delta < 0 ? length - 1 : 0;
  return (current + delta + length) % length;
}

/**
 * Where the highlight rests when a view's shape changes. With an empty query,
 * honour the view's default (which may be `null`). Once the user has typed a
 * filter, highlight the first match so Enter selects it — falling back to nothing
 * when the filtered list is empty.
 */
export function snappedIndex(
  query: string,
  length: number,
  defaultIndex: number | null,
): number | null {
  if (query !== '') {
    return length > 0 ? 0 : null;
  }
  return defaultIndex;
}

export interface KeyboardSelectionCapabilities {
  /** Escape triggers `onBack`. */
  readonly back?: boolean | undefined;
  /** Backspace on an empty query triggers `onBack` (drilling back out of a flow). */
  readonly backOnEmptyQuery?: boolean | undefined;
  /** Tab triggers `onFill` (shell-style path completion). */
  readonly fill?: boolean | undefined;
  /** Space triggers `onToggleHighlighted` (multi-select). */
  readonly toggle?: boolean | undefined;
}

export interface KeyboardSelectionHandlers {
  /** Enter — the consumer branches on its current view/selection. */
  readonly onAccept: () => void;
  readonly onBack?: (() => void) | undefined;
  readonly onFill?: (() => void) | undefined;
  /** Space — toggle the currently highlighted option (multi-select). */
  readonly onToggleHighlighted?: (() => void) | undefined;
}

export interface KeyboardSelection {
  readonly selectedIndex: number | null;
  readonly onKeyDown: (event: ReactKeyboardEvent) => void;
}

/**
 * Shared keyboard-list selection for the command palette and the workflow input
 * flow. Owns the highlight index, snaps it to the view's default whenever the
 * view shape changes (keyed by `snapKey`), moves it on arrow keys, and routes
 * the rest of the keys to consumer-supplied handlers gated by `capabilities`.
 *
 * Snapping happens synchronously during render (React's "adjust state while
 * rendering" pattern) so the highlight is correct in the same commit — there is
 * no post-render snap effect and no one-frame flash. Callers must therefore make
 * `snapKey` change whenever `length`, `defaultIndex`, or the query mode changes.
 */
export function useKeyboardSelection({
  length,
  snapKey,
  defaultIndex,
  query = '',
  capabilities = {},
  handlers,
}: {
  readonly length: number;
  readonly snapKey: string;
  readonly defaultIndex: number | null;
  readonly query?: string | undefined;
  readonly capabilities?: KeyboardSelectionCapabilities | undefined;
  readonly handlers: KeyboardSelectionHandlers;
}): KeyboardSelection {
  const [snapped, setSnapped] = useState<{
    readonly index: number | null;
    readonly snapKey: string;
  }>(() => ({ index: snappedIndex(query, length, defaultIndex), snapKey }));

  let selectedIndex = snapped.index;
  if (snapped.snapKey !== snapKey) {
    selectedIndex = snappedIndex(query, length, defaultIndex);
    setSnapped({ index: selectedIndex, snapKey });
  }

  const move = (delta: number) => {
    setSnapped((current) => ({ ...current, index: moveIndex(current.index, delta, length) }));
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.defaultPrevented) {
      return;
    }
    if (event.key === 'ArrowDown' && length > 0) {
      event.preventDefault();
      event.stopPropagation();
      move(1);
    } else if (event.key === 'ArrowUp' && length > 0) {
      event.preventDefault();
      event.stopPropagation();
      move(-1);
    } else if (event.key === 'Tab') {
      // The highlight is the single source of truth for what Enter acts on, so
      // Tab never traverses focus onto body buttons (which would desync focus
      // from the highlight) or out of the panel. On path steps it fills the
      // highlighted directory; everywhere else it is simply inert.
      event.preventDefault();
      event.stopPropagation();
      if (capabilities.fill && handlers.onFill) {
        handlers.onFill();
      }
    } else if (event.key === ' ' && capabilities.toggle && handlers.onToggleHighlighted) {
      event.preventDefault();
      event.stopPropagation();
      handlers.onToggleHighlighted();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      handlers.onAccept();
    } else if (event.key === 'Escape' && capabilities.back && handlers.onBack) {
      event.preventDefault();
      event.stopPropagation();
      handlers.onBack();
    } else if (
      event.key === 'Backspace' &&
      query === '' &&
      capabilities.backOnEmptyQuery &&
      handlers.onBack
    ) {
      event.preventDefault();
      event.stopPropagation();
      handlers.onBack();
    }
  };

  return { selectedIndex, onKeyDown };
}
