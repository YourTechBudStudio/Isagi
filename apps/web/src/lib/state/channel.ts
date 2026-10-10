/**
 * Per-registry imperative objects, for subsystems that are callbacks and DOM rather than Effects.
 */
import { Atom, type AtomRegistry } from 'effect/reactivity';

/** A synchronous publish/subscribe channel. Listeners added during a publish see the next one. */
export interface Channel<A> {
  readonly publish: (value: A) => void;
  readonly subscribe: (listener: (value: A) => void) => () => void;
}

export const makeChannel = <A>(): Channel<A> => {
  const listeners = new Set<(value: A) => void>();
  return {
    publish: (value) => {
      for (const listener of [...listeners]) listener(value);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
};

/**
 * A "session object": one imperative object per registry, created on first read and kept for the
 * registry's life. For subsystems that are callbacks and DOM, not Effects (focus router, terminal
 * facts). Never put rendered state in one: rendered state is an atom.
 */
export const sessionObject = <A extends object>(
  make: (registry: AtomRegistry.AtomRegistry) => A,
): Atom.Atom<A> => Atom.make((get) => make(get.registry)).pipe(Atom.keepAlive);

/**
 * Latest-wins per key. `claim(key)` starts a new write for `key` and returns a check that stays
 * true only while no newer write for the same key has been claimed. Nothing is aborted; a stale
 * write's outcome is simply ignored.
 */
export interface LatestWins<K> {
  readonly claim: (key: K) => () => boolean;
}

export const makeLatestWins = <K>(): LatestWins<K> => {
  const latest = new Map<K, number>();
  return {
    claim: (key) => {
      const sequence = (latest.get(key) ?? 0) + 1;
      latest.set(key, sequence);
      return () => latest.get(key) === sequence;
    },
  };
};
