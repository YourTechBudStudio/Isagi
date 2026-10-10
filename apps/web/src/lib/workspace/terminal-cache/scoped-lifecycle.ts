export interface ScopedLifecycle {
  readonly addFinalizer: (finalizer: () => void) => void;
  readonly dispose: () => void;
}

/**
 * A synchronously owned lifecycle for browser resources whose cleanup APIs are synchronous
 * (DOM nodes, xterm instances, cache subscriptions).
 *
 * Plain code on purpose: every finalizer is synchronous, so an Effect `Scope` here only added
 * `Effect.runSync` run sites (R12) without buying interruption or async cleanup. The semantics are
 * the ones the `Scope` gave: finalizers run once, newest first; every finalizer runs even when an
 * earlier one throws, and the first error is rethrown afterwards; a finalizer added after disposal
 * runs immediately.
 */
export function createScopedLifecycle(): ScopedLifecycle {
  const finalizers: Array<() => void> = [];
  let closed = false;

  return {
    addFinalizer(finalizer) {
      if (closed) {
        finalizer();
        return;
      }
      finalizers.push(finalizer);
    },
    dispose() {
      if (closed) return;
      closed = true;
      let failure: { readonly error: unknown } | null = null;
      for (const finalizer of finalizers.splice(0).toReversed()) {
        try {
          finalizer();
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure) throw failure.error;
    },
  };
}
