import { Effect, Layer } from 'effect';

import {
  InternalRuntimeEventBus,
  InternalRuntimeEventBusLive,
  type InternalRuntimeEvent,
  type InternalRuntimeEventBusService,
} from './internal-event-bus.js';

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
  readonly events: InternalRuntimeEvent[];
  readonly service: InternalRuntimeEventBusService;
  readonly layer: Layer.Layer<InternalRuntimeEventBusService>;
}

/**
 * Records publications and dies on subscription.
 *
 * For a unit whose contract is "publishes, and does not listen". A subscription
 * from such a unit is a design change, and it should fail loudly in the test
 * that asserted otherwise rather than pass silently through a queue nobody
 * drains.
 */
export function publishOnlyRecordingEventBus(reason: string): RecordingEventBus {
  const events: InternalRuntimeEvent[] = [];
  const service: InternalRuntimeEventBusService = {
    publish: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    subscribe: () => Effect.die(reason),
  };
  return {
    events,
    service,
    layer: Layer.succeed(InternalRuntimeEventBus, service),
  };
}

/**
 * The real bus, with every publication also recorded.
 *
 * Decorating `InternalRuntimeEventBusLive` rather than reimplementing it keeps
 * the type filters, the unbounded queues, unsubscribe, and the scoped shutdown
 * exactly as production has them. That matters for any unit that both publishes
 * and runs a subscriber loop of its own: a hand-written fake would be asserting
 * against its own delivery semantics rather than the runtime's.
 */
export function recordingInternalEventBusLayer(events: InternalRuntimeEvent[]) {
  return Layer.effect(
    InternalRuntimeEventBus,
    Effect.gen(function* () {
      const bus = yield* InternalRuntimeEventBus;
      return {
        publish: (event) =>
          Effect.sync(() => {
            events.push(event);
          }).pipe(Effect.zipRight(bus.publish(event))),
        subscribe: bus.subscribe,
      } satisfies InternalRuntimeEventBusService;
    }),
  ).pipe(Layer.provide(InternalRuntimeEventBusLive));
}
