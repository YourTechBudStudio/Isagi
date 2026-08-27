import { useEffect, useMemo, useRef, useState } from 'react';

import { createClipboardCopy, type ClipboardCopyState } from './clipboard-copy.js';

/**
 * The one copy-with-confirmation mechanism. Every URL affordance uses it, so the
 * concurrency and reset behavior exists once (see `clipboard-copy.ts` for the
 * contract it binds).
 *
 * `onSettled` is read through a ref so a caller can pass an inline closure
 * without rebuilding the controller and losing an in-flight invocation's token.
 */
export function useClipboardCopy(onSettled?: (state: 'copied' | 'failed') => void): {
  readonly state: ClipboardCopyState;
  readonly copy: (text: string) => void;
} {
  const [state, setState] = useState<ClipboardCopyState>('idle');
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  const controller = useMemo(
    () =>
      createClipboardCopy({
        writeText:
          typeof navigator !== 'undefined' && navigator.clipboard
            ? (text) => navigator.clipboard.writeText(text)
            : null,
        onState: setState,
        onSettled: (settledState) => settledRef.current?.(settledState),
        setTimer: (run, ms) => setTimeout(run, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      }),
    [],
  );

  // Nothing survives the component: the pending reset is cleared and any late
  // settlement is dropped before it can write state into an unmounted tree.
  useEffect(() => () => controller.dispose(), [controller]);

  return { state, copy: controller.copy };
}
