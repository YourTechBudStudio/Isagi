import { Effect, Exit, Layer, Queue, Scope, Stream } from 'effect';

import { InternalEvents, type InternalEvent, type InternalEventOf } from './internal-events.js';
import { RuntimeEvents } from './runtime-events.js';

/**
 * Two deliberately different recording buses.
 *
 * They are not one helper with a flag, because the difference between them is an
 * assertion rather than a configuration: the first proves a unit *never*
 * subscribes, and the second exists precisely for units that do. Collapsing them
 * into a single permissive fake would quietly delete the first proof.
 *
 * Neither is exported from the production barrel.
 */

export interface RecordingEventBus {
  readonly events: InternalEvent[];
  readonly service: InternalEvents['Service'];
  readonly layer: Layer.Layer<InternalEvents>;
}

/**
 * Records publications and dies on subscription.
 *
 * For a unit whose contract is "publishes, and does not listen". A subscription
 * from such a unit is a design change, and it should fail loudly in the test
 * that asserted otherwise rather than pass silently through a subscription nobody
 * drains.
 */
export function publishOnlyRecordingEventBus(reason: string): RecordingEventBus {
  const events: InternalEvent[] = [];
  const service = InternalEvents.of({
    publish: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    subscribe: () => Effect.die(reason),
  });
  return {
    events,
    service,
    layer: Layer.succeed(InternalEvents, service),
  };
}

/**
 * The real bus, with every publication also recorded.
 *
 * Decorating `InternalEvents.layer` rather than reimplementing it keeps the type
 * filters, the unbounded `PubSub`, scoped subscriptions, and the shutdown exactly
 * as production has them. That matters for any unit that both publishes and runs
 * a subscriber loop of its own: a hand-written fake would be asserting against
 * its own delivery semantics rather than the runtime's.
 */
export function recordingInternalEventBusLayer(events: InternalEvent[]) {
  return Layer.effect(
    InternalEvents,
    Effect.gen(function* () {
      const bus = yield* InternalEvents;
      return InternalEvents.of({
        publish: (event) =>
          Effect.sync(() => {
            events.push(event);
          }).pipe(Effect.andThen(bus.publish(event))),
        subscribe: bus.subscribe,
      });
    }),
  ).pipe(Layer.provide(InternalEvents.layer));
}

/** Events taken one at a time from a subscription, for tests that assert what was published and in which order. */
export interface EventTap<E> {
  /** The next delivered event; waits until one is published. */
  readonly take: Effect.Effect<E>;
  /** Ends the subscription before the caller's scope closes; later publications are no longer delivered. */
  readonly unsubscribe: Effect.Effect<void>;
}

/** Subscribes to `types` now (in the caller's scope) and hands the events out through `take`. */
export const tapInternalEvents = <const T extends InternalEvent['type']>(
  types: ReadonlyArray<T>,
): Effect.Effect<EventTap<InternalEventOf<T>>, never, InternalEvents | Scope.Scope> =>
  Effect.gen(function* () {
    const bus = yield* InternalEvents;
    return yield* tap(bus.subscribe(types));
  });

/** Subscribes to the public runtime events now (in the caller's scope) and hands them out through `take`. */
export const tapRuntimeEvents = Effect.gen(function* () {
  const bus = yield* RuntimeEvents;
  return yield* tap(bus.subscribe);
});

function tap<E>(subscribe: Effect.Effect<Stream.Stream<E>, never, Scope.Scope>) {
  return Effect.gen(function* () {
    // A child of the caller's scope, so the tap ends with the test's scope or earlier through `unsubscribe`.
    const scope = yield* Scope.fork(yield* Effect.scope);
    const queue = yield* subscribe.pipe(
      Effect.flatMap((events) => Stream.toQueue(events, { capacity: 'unbounded' })),
      Scope.provide(scope),
    );
    return {
      take: Queue.take(queue).pipe(Effect.orDie),
      unsubscribe: Scope.close(scope, Exit.void),
    } satisfies EventTap<E>;
  });
}
