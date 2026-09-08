import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { moveIndex } from '../lib/keyboard-selection.js';

export { moveIndex };

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

/**
 * A highlight owned outside this hook. Path screens use it so the palette machine
 * is the single owner of what Enter acts on; every other view leaves it unset and
 * the hook owns its own highlight as before.
 */
export interface KeyboardSelectionSource {
  readonly index: number | null;
  readonly move: (delta: number) => void;
}

export interface KeyboardSelectionCapabilities {
  /** Escape triggers `onBack`. */
  readonly back?: boolean | undefined;
  /** Backspace on an empty query triggers `onBack` (drilling back out of a flow). */
  readonly backOnEmptyQuery?: boolean | undefined;
  /** Tab and Shift+Tab cycle the highlight instead of being inert. */
  readonly cycle?: boolean | undefined;
  /** "/" is a completion separator rather than ordinary text. */
  readonly separator?: boolean | undefined;
  /** Space triggers `onToggleHighlighted` (multi-select). */
  readonly toggle?: boolean | undefined;
}

export interface KeyboardSelectionHandlers {
  /** Enter — the consumer branches on its current view/selection. */
  readonly onAccept: () => void;
  readonly onBack?: (() => void) | undefined;
  /** "/" pressed with a highlight: accept that directory and descend into it. */
  readonly onDescend?: (() => void) | undefined;
  /** Space — toggle the currently highlighted option (multi-select). */
  readonly onToggleHighlighted?: (() => void) | undefined;
}

/**
 * Whether a "/" keystroke would only add a second separator to a buffer that
 * already ends in one. True only for a collapsed caret sitting at the very end of
 * the value, so mid-buffer editing and range selections stay ordinary input.
 */
function isDuplicateSeparator(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLInputElement)) return false;
  return (
    target.selectionStart === target.selectionEnd &&
    target.selectionStart === target.value.length &&
    target.value.endsWith('/')
  );
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
 *
 * Pass `selection` to hand the highlight to an external owner. In that mode the
 * hook reads and moves only that highlight and performs no snap and no internal
 * write, so there is never a second index to keep in step. Because the skipped
 * render also leaves the stored `snapKey` untouched, a later uncontrolled view
 * snaps exactly when its key differs from the last one this hook stored.
 */
export function useKeyboardSelection({
  length,
  snapKey,
  defaultIndex,
  query = '',
  capabilities = {},
  handlers,
  selection,
}: {
  readonly length: number;
  readonly snapKey: string;
  readonly defaultIndex: number | null;
  readonly query?: string | undefined;
  readonly capabilities?: KeyboardSelectionCapabilities | undefined;
  readonly handlers: KeyboardSelectionHandlers;
  readonly selection?: KeyboardSelectionSource | undefined;
}): KeyboardSelection {
  const [snapped, setSnapped] = useState<{
    readonly index: number | null;
    readonly snapKey: string;
  }>(() => ({ index: snappedIndex(query, length, defaultIndex), snapKey }));

  let selectedIndex: number | null;
  if (selection) {
    selectedIndex = selection.index;
  } else {
    selectedIndex = snapped.index;
    if (snapped.snapKey !== snapKey) {
      selectedIndex = snappedIndex(query, length, defaultIndex);
      setSnapped({ index: selectedIndex, snapKey });
    }
  }

  const move =
    selection?.move ??
    ((delta: number) => {
      setSnapped((current) => ({ ...current, index: moveIndex(current.index, delta, length) }));
    });

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.defaultPrevented) {
      return;
    }
    // An IME composition must never commit a step. Return without preventing
    // anything: the keystroke is ordinary text input for the composing editor.
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
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
      // from the highlight) or out of the panel. Where cycling is offered it
      // moves the highlight; everywhere else, and with nothing to cycle, it is
      // swallowed and inert.
      event.preventDefault();
      event.stopPropagation();
      if (capabilities.cycle && length > 0) {
        move(event.shiftKey ? -1 : 1);
      }
    } else if (event.key === ' ' && capabilities.toggle && handlers.onToggleHighlighted) {
      event.preventDefault();
      event.stopPropagation();
      handlers.onToggleHighlighted();
    } else if (
      event.key === '/' &&
      capabilities.separator &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      // Descent wins over the caret: navigating onto a directory makes "/" an
      // operation on that directory wherever the caret happens to sit.
      if (selectedIndex !== null && handlers.onDescend) {
        event.preventDefault();
        event.stopPropagation();
        handlers.onDescend();
      } else if (isDuplicateSeparator(event.target)) {
        // Swallow the second separator; anything else is ordinary editing.
        event.preventDefault();
        event.stopPropagation();
      }
    } else if (event.key === 'Enter') {
      // Prevented and stopped even when ignored, so a held Enter can neither
      // reach a handler twice nor fall through to native activation.
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        handlers.onAccept();
      }
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
