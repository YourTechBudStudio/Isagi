/**
 * The workflow layer's live state: what the shared runtime connection has told it, kept per app
 * session (per atom registry) rather than in module variables.
 *
 * `receiveWorkflowSignal` (`sync.ts`) applies each pushed fact to the workflow reads; this file
 * holds what that needs between facts: the connection phase the bar shows, events held for reads
 * still in flight, the 250 ms refetch windows, and a feed of the facts for the one waiter that needs
 * them (`awaitPreparation`). A (re)connect re-reads every live read through their shared
 * `keys.workflowLive` invalidation key.
 */
import { Duration, Effect, FiberMap, PubSub, type Scope } from 'effect';
import { Atom, Reactivity } from 'effect/reactivity';

import type { WorkflowEventDto, WorkflowRunSummary } from '@isagi/contracts';

import { appRuntime } from '../../state/runtime.js';

/**
 * What the shared runtime connection tells the workflow layer.
 *
 * `connected`/`disconnected` are facts too, because a client that was offline has to re-read what
 * it missed.
 */
export type WorkflowSignal =
  | { readonly type: 'connected' }
  | { readonly type: 'disconnected' }
  | { readonly type: 'snapshot'; readonly summaries: readonly WorkflowRunSummary[] }
  | { readonly type: 'run_changed'; readonly summary: WorkflowRunSummary }
  | { readonly type: 'run_event'; readonly event: WorkflowEventDto };

export type RuntimeConnectionPhase = 'connecting' | 'connected' | 'disconnected';

/**
 * The connection's current phase, not just its transitions.
 *
 * A reader that only learned from future signals would start at `connecting` forever if it mounted
 * after the socket opened, which is ordinary: the bar unmounts and remounts with zen mode. A state
 * atom replays the phase to whoever reads it next.
 */
export const runtimeConnectionPhaseAtom = Atom.make<RuntimeConnectionPhase>('connecting').pipe(
  Atom.keepAlive,
);

/**
 * How long a burst of events for one read is collected before that read is refetched once.
 *
 * A running node appends several events within milliseconds (started, operation started and
 * finished, waiting), and each names the same run. One refetch per burst is enough.
 */
export const workflowRefetchDelay = Duration.millis(250);

/** The session's live-sync handle. */
export interface WorkflowLive {
  /** Keep an event for the read of `runId` that is in flight; that read merges it when it lands. */
  readonly hold: (runId: number, event: WorkflowEventDto) => void;
  /** The events held for `runId`, removed. */
  readonly takeHeld: (runId: number) => readonly WorkflowEventDto[];
  /**
   * Invalidate `key` once, `workflowRefetchDelay` after the first request in a burst; requests
   * while a window is open join it. Only a read someone is looking at refetches.
   */
  readonly refetchSoon: (key: string) => Effect.Effect<void>;
  /** Every applied signal, in order, for waiters that react to pushed facts. */
  readonly publish: (signal: WorkflowSignal) => Effect.Effect<void>;
  /** Subscribe before reading, so nothing pushed in between is missed. */
  readonly subscribe: Effect.Effect<PubSub.Subscription<WorkflowSignal>, never, Scope.Scope>;
}

/**
 * The live-sync state as a resource atom: built on first use per registry, and its fibers and feed
 * die with the registry. Nothing mounts it.
 */
export const workflowLiveAtom = appRuntime
  .atom(
    Effect.gen(function* () {
      const reactivity = yield* Reactivity.Reactivity;
      const windows = yield* FiberMap.make<string>();
      const signals = yield* PubSub.unbounded<WorkflowSignal>();
      yield* Effect.addFinalizer(() => PubSub.shutdown(signals));
      const held = new Map<number, readonly WorkflowEventDto[]>();
      const live: WorkflowLive = {
        hold: (runId, event) => {
          held.set(runId, [...(held.get(runId) ?? []), event]);
        },
        takeHeld: (runId) => {
          const events = held.get(runId) ?? [];
          held.delete(runId);
          return events;
        },
        refetchSoon: (key) =>
          FiberMap.run(
            windows,
            key,
            Effect.sleep(workflowRefetchDelay).pipe(Effect.andThen(reactivity.invalidate([key]))),
            { onlyIfMissing: true },
          ).pipe(Effect.asVoid),
        publish: (signal) => PubSub.publish(signals, signal).pipe(Effect.asVoid),
        subscribe: PubSub.subscribe(signals),
      };
      return live;
    }),
  )
  .pipe(Atom.keepAlive);

/** The session's live handle, from inside an app effect. */
export const workflowLive = Atom.getResult(workflowLiveAtom);

/** Events by id, each once. Both sides are already in id order in practice; this does not rely on it. */
export function mergeEvents(
  current: readonly WorkflowEventDto[],
  incoming: readonly WorkflowEventDto[],
): readonly WorkflowEventDto[] {
  const last = current.at(-1)?.eventId ?? 0;
  // The common case: a pushed event newer than everything held.
  if (incoming.every((event) => event.eventId > last) && isAscending(incoming)) {
    return incoming.length === 0 ? current : [...current, ...incoming];
  }
  const byId = new Map<number, WorkflowEventDto>();
  for (const event of current) byId.set(event.eventId, event);
  for (const event of incoming) byId.set(event.eventId, event);
  return [...byId.values()].sort((left, right) => left.eventId - right.eventId);
}

function isAscending(events: readonly WorkflowEventDto[]): boolean {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.eventId <= events[index - 1]!.eventId) return false;
  }
  return true;
}
