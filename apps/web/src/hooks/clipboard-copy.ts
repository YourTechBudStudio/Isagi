/**
 * The clipboard-copy concurrency contract, as a plain state machine.
 *
 * It lives outside React because the interesting behavior is ordering, not
 * rendering: overlapping clicks, a slow rejection landing after a newer success,
 * and a reset timer that must belong to the invocation that started it. Those are
 * testable here against a stub clock; the hook in `useClipboardCopy.ts` is a thin
 * binding that supplies the real clipboard and `setTimeout`.
 */

export type ClipboardCopyState = 'idle' | 'copied' | 'failed';

/** How long a settled state stays visible before returning to idle. */
export const CLIPBOARD_RESET_DELAY_MS = 1800;

export interface ClipboardCopyDeps {
  /** `navigator.clipboard.writeText`, or `null` when the API is absent. */
  readonly writeText: ((text: string) => Promise<void>) | null;
  readonly onState: (state: ClipboardCopyState) => void;
  /** Fired once per applied settlement, after `onState`. Never fires for `idle`. */
  readonly onSettled?: ((state: 'copied' | 'failed') => void) | undefined;
  readonly setTimer: (run: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly resetDelayMs?: number | undefined;
}

export interface ClipboardCopy {
  readonly copy: (text: string) => void;
  readonly dispose: () => void;
}

export function createClipboardCopy(deps: ClipboardCopyDeps): ClipboardCopy {
  const resetDelayMs = deps.resetDelayMs ?? CLIPBOARD_RESET_DELAY_MS;
  let token = 0;
  let timer: unknown = null;
  let disposed = false;

  const clearPending = () => {
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
  };

  // Last-invocation-wins. A settlement is applied only while its own token is
  // still the newest, so an older slow rejection can never overwrite a newer
  // click's success — or the other way round.
  const settle = (invocation: number, state: 'copied' | 'failed') => {
    if (disposed || invocation !== token) {
      return;
    }
    deps.onState(state);
    deps.onSettled?.(state);
    timer = deps.setTimer(() => {
      timer = null;
      if (!disposed && invocation === token) {
        deps.onState('idle');
      }
    }, resetDelayMs);
  };

  return {
    copy(text: string) {
      if (disposed) {
        return;
      }
      const invocation = ++token;
      // The previous invocation's reset timer belonged to it; a newer copy owns
      // the state now and clears it before writing.
      clearPending();
      // Synchronous reset: a retry never keeps showing the previous invocation's
      // `copied` or `failed` while its own write is still pending. There is no
      // explicit pending state — `writeText` settles in milliseconds, so a voiced
      // pending presentation would only flash, and `idle` is the honest
      // in-between.
      deps.onState('idle');

      const writeText = deps.writeText;
      if (!writeText) {
        settle(invocation, 'failed');
        return;
      }
      writeText(text).then(
        () => settle(invocation, 'copied'),
        () => settle(invocation, 'failed'),
      );
    },
    dispose() {
      disposed = true;
      clearPending();
    },
  };
}
