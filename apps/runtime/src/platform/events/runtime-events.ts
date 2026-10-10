import { Context, Effect, Layer, PubSub, Stream, type Scope } from 'effect';

import type { RuntimeEvent } from '@isagi/contracts';

/**
 * The public runtime-event bus: what the events WebSocket streams to clients. Published by environment (projection),
 * commands and workflows; consumed by the `runtime-events` module.
 *
 * Built on an unbounded `PubSub`, like `InternalEvents`: publishing never waits for a subscriber, and publishing after
 * the bus shut down is a no-op.
 */
export class RuntimeEvents extends Context.Service<
  RuntimeEvents,
  {
    readonly publish: (event: RuntimeEvent) => Effect.Effect<void>;
    /**
     * Subscribes now, in the caller's scope: every event published after this effect completes is delivered to the
     * returned stream, in publish order. The subscription ends when the scope closes.
     */
    readonly subscribe: Effect.Effect<Stream.Stream<RuntimeEvent>, never, Scope.Scope>;
  }
>()('isagi/runtime/platform/events/RuntimeEvents') {
  static readonly layer = Layer.effect(
    RuntimeEvents,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<RuntimeEvent>();
      yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub));
      return RuntimeEvents.of({
        publish: (event) => PubSub.publish(pubsub, event).pipe(Effect.asVoid),
        subscribe: PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription)),
      });
    }),
  );
}

let eventCounter = 0;

export function nextRuntimeEventEnvelope() {
  eventCounter += 1;
  const occurredAt = new Date().toISOString();
  return {
    id: `evt_${Date.now()}_${eventCounter}`,
    occurredAt,
  };
}
