/**
 * The app's atom registry and how code reaches it.
 *
 * One registry per app session, created explicitly by the page (`main.tsx`, each browser fixture)
 * and provided with `AppStateProvider`. No module exports a registry: React code uses
 * `useRegistry()`, Effect code reads `AtomRegistry.AtomRegistry` from its context, and plain
 * functions take the registry as their first parameter. Never use atom-react's `RegistryProvider`
 * (it creates and later disposes a second registry) and never rely on `RegistryContext`'s default
 * value (a module-level registry).
 */
import { scheduleTask } from '@effect/atom-react';
import type { Effect } from 'effect';
import { type Atom, AtomRegistry } from 'effect/reactivity';
import { createContext, useCallback, useContext } from 'react';

import { runApp, type AppRequirements } from './runtime.js';

export interface AppRegistryOptions {
  /** Seeds for atoms, e.g. `[queryRetryAtom, null]` to turn query retries off in a fixture. */
  readonly initialValues?: Iterable<readonly [Atom.Atom<any>, any]> | undefined;
}

/**
 * A new, fully isolated app session. No default idle TTL: retention is per query (policy) and
 * state atoms are keepAlive. React's scheduler runs the registry's deferred work.
 */
export const makeAppRegistry = (options: AppRegistryOptions = {}): AtomRegistry.AtomRegistry =>
  AtomRegistry.make({ scheduleTask, initialValues: options.initialValues });

/** Provided by `AppStateProvider`; `null` outside it. */
export const AppRegistryContext = createContext<AtomRegistry.AtomRegistry | null>(null);

/** The app registry. Throws outside `AppStateProvider` so state can never silently split. */
export function useRegistry(): AtomRegistry.AtomRegistry {
  const registry = useContext(AppRegistryContext);
  if (registry === null) throw new Error('AppStateProvider is missing');
  return registry;
}

/** Runs an app effect from an event handler, against the same services as the atoms. */
export type AppRun = <A, E>(effect: Effect.Effect<A, E, AppRequirements>) => Promise<A>;

export function useAppRun(): AppRun {
  const registry = useRegistry();
  return useCallback<AppRun>((effect) => runApp(registry, effect), [registry]);
}
