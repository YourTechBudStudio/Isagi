/**
 * Isagi's freshness policy for runtime-owned reads.
 *
 * Reproduces the old QueryClient defaults (10 s stale, revalidate-if-stale on focus and reconnect,
 * retry 3 with 1 s / 2 s / 4 s backoff, 5 min idle retention) out of built-in Atom pieces. Domains
 * override per query; there is no other cache machinery.
 */
import { Duration, Effect, Option, Schedule, type Scope } from 'effect';
import { AsyncResult, Atom, AtomRegistry, type Reactivity } from 'effect/reactivity';

import type { RuntimeApi } from '../runtime/client.js';
import { appReactivityAtom, appRuntime } from './runtime.js';

/**
 * Bumped when the window becomes visible and when the browser comes back online. One signal,
 * because the policy for both is identical: revalidate what is stale. Writable so tests drive it.
 */
export const revalidationSignalAtom = Atom.make(0).pipe(Atom.keepAlive);

export interface RevalidationTarget {
  readonly addEventListener: (type: string, listener: () => void) => void;
  readonly removeEventListener: (type: string, listener: () => void) => void;
}

/**
 * Installed once per page (`main.tsx`, browser fixtures). Returns the uninstall. There is no
 * built-in online signal, and `Atom.windowFocusSignal` is visibility-only, so both events are
 * folded into `revalidationSignalAtom` here.
 */
export const connectBrowserRevalidation = (
  registry: AtomRegistry.AtomRegistry,
  target: RevalidationTarget,
  isVisible: () => boolean,
): (() => void) => {
  const bump = () => registry.update(revalidationSignalAtom, (n) => n + 1);
  const onVisibility = () => {
    if (isVisible()) bump();
  };
  target.addEventListener('visibilitychange', onVisibility);
  target.addEventListener('online', bump);
  return () => {
    target.removeEventListener('visibilitychange', onVisibility);
    target.removeEventListener('online', bump);
  };
};

/** The old default `retry: 3` with `min(1000 * 2^n, 30000)` delays: 1 s, 2 s, 4 s. */
export const defaultRetry = { schedule: Schedule.exponential('1 second'), times: 3 } as const;

/** Registry-level retry switch. Tests and browser fixtures seed `null` to fail fast. */
export const queryRetryAtom = Atom.make<typeof defaultRetry | null>(defaultRetry).pipe(
  Atom.keepAlive,
);

export interface QueryPolicy {
  /** Invalidation keys (flat strings from `keys.ts`), registered for the node's retained life. */
  readonly keys: ReadonlyArray<string>;
  /** Default 10 s. `Duration.infinity` = never stale (a failed read is still retried on remount). */
  readonly staleTime?: Duration.Input | undefined;
  /** Default 5 minutes. `Duration.infinity` = kept for the registry's life. */
  readonly idleTTL?: Duration.Input | undefined;
  /** Default true (3 retries). `false` for workflow reads. */
  readonly retry?: boolean | undefined;
}

export type QueryServices =
  | RuntimeApi
  | Reactivity.Reactivity
  | AtomRegistry.AtomRegistry
  | Scope.Scope;

/** A retained query node: its value, writable with an updater that patches a held success. */
export type Cached<A, E> = Atom.Writable<AsyncResult.AsyncResult<A, E>, (current: A) => A>;

/** A query's policy with every default filled in: what it actually runs with. */
export interface ResolvedQueryPolicy {
  readonly keys: ReadonlyArray<string>;
  readonly staleTime: Duration.Duration;
  readonly idleTTL: Duration.Duration;
  /** Whether a failed read is retried with {@link defaultRetry} (unless the registry turns it off). */
  readonly retry: boolean;
}

/** The view components read; `cache` is the retained node (idle TTL) that holds the data. */
export interface Query<A, E> extends Cached<A, E> {
  readonly cache: Cached<A, E>;
  /** The resolved policy, readable so the policy table test can check every resource against v3. */
  readonly policy: ResolvedQueryPolicy;
}

/**
 * The one constructor for runtime-owned reads. Call it at module level or inside `Atom.family`,
 * never during render.
 *
 * - base: `appRuntime.atom(read |> retry)`, registered on `keys` for its whole retained life, so an
 *   invalidation while nobody watches marks it stale instead of being lost;
 * - cache: `Atom.setIdleTTL(base, idleTTL)`;
 * - view: `Atom.swr(cache, staleTime, focusSignal = revalidationSignalAtom)` for mount, focus and
 *   reconnect revalidation.
 */
export const query = <A, E>(
  read: (get: Atom.AtomContext) => Effect.Effect<A, E, QueryServices>,
  policy: QueryPolicy,
): Query<A, E> => {
  const resolved: ResolvedQueryPolicy = {
    keys: policy.keys,
    staleTime: Duration.fromInputUnsafe(policy.staleTime ?? Duration.seconds(10)),
    idleTTL: Duration.fromInputUnsafe(policy.idleTTL ?? Duration.minutes(5)),
    retry: policy.retry !== false,
  };
  const base = appRuntime.atom((get) => {
    invalidatedBy(get, resolved.keys);
    const effect = read(get);
    const retry = get.once(queryRetryAtom);
    return !resolved.retry || retry === null ? effect : Effect.retry(effect, retry);
  });
  // A write patches a held success in place (the old `setQueryData`); a read already in flight
  // still lands over it, as before. `cache` is the only node ever mounted, so the write reads it.
  let cache: Cached<A, E>;
  const node: Cached<A, E> = Atom.writable(
    (get) => base.read(get),
    (ctx, update: (current: A) => A) => {
      const current = ctx.get(cache);
      if (current._tag === 'Success') {
        ctx.setSelf(AsyncResult.success(update(current.value), { waiting: current.waiting }));
      }
    },
  );
  cache = Atom.setIdleTTL(node, resolved.idleTTL);
  const view = Atom.swr(cache, {
    staleTime: resolved.staleTime,
    revalidateOnFocus: true,
    focusSignal: revalidationSignalAtom,
  });
  // `Atom.family` holds its members (the views) weakly, while the registry holds `cache` strongly
  // for as long as it is retained. The back-reference keeps the view alive exactly that long, so a
  // family keeps returning the same query instead of building a second cache after a GC.
  Object.defineProperty(cache, 'view', { value: view });
  return Object.assign(view, { cache, policy: resolved });
};

/**
 * The retained value of a query WITHOUT creating its node (so without starting a read); the old
 * `getQueryState`. `None` = nothing holds this query (never read, or collected).
 */
export const peek = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  q: Query<A, E>,
): Option.Option<AsyncResult.AsyncResult<A, E>> => {
  const node = registry.getNodes().get(q.cache);
  return node === undefined ? Option.none() : node.valueOption();
};

/** The old `setQueryData`, on a held success only: never creates a node, never clears an error. */
export const patch = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  q: Query<A, E>,
  update: (current: A) => A,
): void => {
  const held = peek(registry, q);
  if (Option.isSome(held) && held.value._tag === 'Success') registry.set(q.cache, update);
};

/**
 * Register the current node on `keys`; an invalidation refreshes it (observed: refetch now;
 * retained but unobserved: marked stale). Not `Atom.withReactivity`, which would lose an
 * invalidation that arrives while nobody watches and would fetch even unobserved nodes.
 */
export const invalidatedBy = (get: Atom.AtomContext, keys: ReadonlyArray<string>): void => {
  if (keys.length === 0) return;
  const reactivity = AsyncResult.getOrThrow(get(appReactivityAtom));
  get.addFinalizer(reactivity.registerUnsafe(keys, () => get.refreshSelf()));
};

/**
 * A per-observer override on the same data: a different view over `view`. `staleTime: 0`
 * revalidates on every mount of this view; `pollEvery` refreshes that long after each settled value.
 */
export const observe = <A, E>(
  view: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options: {
    readonly staleTime: Duration.Input;
    readonly pollEvery?: Duration.Input | undefined;
  },
): Atom.Atom<AsyncResult.AsyncResult<A, E>> => {
  const fresh = Atom.swr(view, {
    staleTime: options.staleTime,
    revalidateOnFocus: true,
    focusSignal: revalidationSignalAtom,
  });
  const pollEvery = options.pollEvery;
  return pollEvery === undefined ? fresh : pollWhile(fresh, () => pollEvery);
};

/**
 * Conditional polling (the old `refetchInterval: (query) => ...`): after each settled value,
 * refresh `interval(result)` later; `null` stops. Runs only while observed.
 */
export const pollWhile = <A, E>(
  self: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  interval: (result: AsyncResult.AsyncResult<A, E>) => Duration.Input | null,
): Atom.Atom<AsyncResult.AsyncResult<A, E>> =>
  Atom.transform(self, (get) => {
    const result = get(self);
    const every = result.waiting ? null : interval(result);
    if (every !== null) {
      const handle = setTimeout(
        () => get.refresh(self),
        Duration.toMillis(Duration.fromInputUnsafe(every)),
      );
      get.addFinalizer(() => clearTimeout(handle));
    }
    return result;
  });

/** The `enabled: false` stand-in: `Initial`, not waiting, never fetches. Select it instead of a query. */
export const disabledQuery: Atom.Atom<AsyncResult.AsyncResult<never, never>> = Atom.make(
  AsyncResult.initial<never, never>(),
).pipe(Atom.keepAlive);

/**
 * Cancel-then-read (the old `cancelQueries` + `fetchQuery({ staleTime: 0 })`): `refresh` disposes
 * the in-flight build, whose answer can then never land, and the awaited value is the first settled
 * result of a read that began at or after this call. Fails if that read fails.
 */
export const refreshAndRead = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
  Effect.andThen(Atom.refresh(atom), Atom.getResult(atom, { suspendOnWaiting: true }));

/**
 * The old `await invalidateQueries({ queryKey, exact: true })`: refetch now if the query is held
 * (and wait for it, swallowing its failure); otherwise do nothing.
 */
export const revalidate = <A, E>(q: Query<A, E>) =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;
    if (!registry.getNodes().has(q.cache)) return;
    registry.refresh(q.cache);
    const held = peek(registry, q);
    if (Option.isSome(held) && held.value.waiting) {
      yield* Effect.ignore(Atom.getResult(q.cache, { suspendOnWaiting: true }));
    }
  });
