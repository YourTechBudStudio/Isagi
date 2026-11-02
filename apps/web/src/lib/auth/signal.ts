/**
 * The page's "the runtime wants credentials" signal.
 *
 * Transport code raises it on any runtime response with status 401 (`authAwareRuntimeHttpClient`),
 * which has no registry to write to. `connectAuthSignal` (state.ts) turns it into the page's
 * signed-out state. The web holds no credential fact of its own: the runtime's 401 is the only
 * input, and raising the signal twice is the same as raising it once.
 */
const listeners = new Set<() => void>();

export function signalAuthRequired(): void {
  for (const listener of listeners) listener();
}

/** Subscribes to the signal; the returned function unsubscribes. */
export function onAuthRequired(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
