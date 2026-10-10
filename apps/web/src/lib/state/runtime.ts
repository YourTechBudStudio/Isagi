/**
 * The app runtime: one per atom registry.
 *
 * Every server-state atom runs against `appRuntime`, and every imperative edge (event handlers,
 * sockets, palette commands) runs against the same service instances through `runApp` / `forkApp`.
 * The layer is built once per registry (its memo map is registry-scoped) and disposed with the
 * registry, so a new registry is a fully isolated app. There is no `ManagedRuntime` in the web app.
 */
import { Effect, type Fiber, type Layer } from 'effect';
import { AsyncResult, Atom, AtomRegistry, Reactivity } from 'effect/reactivity';

import { RuntimeApi } from '../runtime/client.js';

/**
 * The only injectable piece: the transport. Production uses `RuntimeApi.layer`; tests seed a fake
 * through the registry's `initialValues`. Browser fixtures keep the production layer and stub
 * `window.fetch` / `window.isagi` instead.
 */
export const runtimeApiLayerAtom = Atom.make<Layer.Layer<RuntimeApi>>(RuntimeApi.layer).pipe(
  Atom.keepAlive,
);

/** Every query and fn atom is built from this runtime. */
export const appRuntime = Atom.runtime((get) => get(runtimeApiLayerAtom)).pipe(Atom.keepAlive);

/** The `Reactivity` instance `appRuntime` merged in; `Reactivity.invalidate` inside app effects uses it. */
export const appReactivityAtom = appRuntime
  .atom(Effect.service(Reactivity.Reactivity))
  .pipe(Atom.keepAlive);

/** What an app effect may require: run it with `runApp` / `forkApp`, or inside an app atom. */
export type AppRequirements = RuntimeApi | Reactivity.Reactivity | AtomRegistry.AtomRegistry;

/**
 * Provide the app services of `registry` to `effect`, so a non-Effect subsystem that runs effects
 * itself gets the same instances as the atoms.
 */
export const provideApp = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  effect: Effect.Effect<A, E, AppRequirements>,
): Effect.Effect<A, E> =>
  // `AtomRuntime<R>` does not list `Reactivity` in `R` although `Atom.runtime` merges it into the
  // context, hence the cast.
  Effect.flatMap(AtomRegistry.getResult(registry, appRuntime), (context) =>
    effect.pipe(
      Effect.provideContext(context),
      Effect.provideService(AtomRegistry.AtomRegistry, registry),
    ),
  ) as Effect.Effect<A, E>;

/**
 * Run an app effect at an imperative edge. Rejects with the failure itself (v4 `runPromise`
 * squashes the cause), so callers classify the rejection directly.
 */
export const runApp = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  effect: Effect.Effect<A, E, AppRequirements>,
  options?: { readonly signal?: AbortSignal | undefined },
): Promise<A> => Effect.runPromise(provideApp(registry, effect), options);

/** Fire-and-forget variant: the fiber is detached from every component and lives with the page. */
export const forkApp = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  effect: Effect.Effect<A, E, AppRequirements>,
): Fiber.Fiber<A, E> => Effect.runFork(provideApp(registry, effect));

/**
 * Invalidate Reactivity keys from non-Effect code (React handlers, imperative subsystems). Keys are
 * flat strings from `keys.ts`; inside an effect use `Reactivity.invalidate` instead.
 */
export const invalidateKeys = (
  registry: AtomRegistry.AtomRegistry,
  keys: ReadonlyArray<string>,
): void => {
  AsyncResult.getOrThrow(registry.get(appReactivityAtom)).invalidateUnsafe(keys);
};
