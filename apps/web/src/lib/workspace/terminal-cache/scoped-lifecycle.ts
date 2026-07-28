import { Effect, Exit, Scope } from 'effect';

export interface ScopedLifecycle {
  readonly addFinalizer: (finalizer: () => void) => void;
  readonly dispose: () => void;
}

/** A synchronously-owned Effect scope for browser resources with synchronous cleanup APIs. */
export function createScopedLifecycle(): ScopedLifecycle {
  const scope = Effect.runSync(Scope.make());
  let closed = false;

  return {
    addFinalizer(finalizer) {
      if (closed) {
        finalizer();
        return;
      }
      Effect.runSync(Scope.addFinalizer(scope, Effect.sync(finalizer)));
    },
    dispose() {
      if (closed) return;
      closed = true;
      Effect.runSync(Scope.close(scope, Exit.void));
    },
  };
}
