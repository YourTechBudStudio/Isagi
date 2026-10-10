import { Context, Effect, Layer, Queue } from 'effect';

import type { RuntimeEvent } from '@isagi/contracts';

export interface RuntimeEventSubscription {
  readonly take: Effect.Effect<RuntimeEvent>;
  readonly unsubscribe: Effect.Effect<void>;
}

const make = Effect.gen(function* () {
  const subscribers = new Set<Queue.Queue<RuntimeEvent>>();

  const service = RuntimeEventBus.of({
    publish: (event) =>
      Effect.sync(() => {
        for (const subscriber of subscribers) {
          Queue.offerUnsafe(subscriber, event);
        }
      }),
    subscribe: Queue.unbounded<RuntimeEvent>().pipe(
      Effect.map((queue) => {
        subscribers.add(queue);
        return {
          take: Queue.take(queue),
          unsubscribe: Effect.sync(() => {
            subscribers.delete(queue);
          }).pipe(Effect.andThen(Queue.shutdown(queue))),
        } satisfies RuntimeEventSubscription;
      }),
    ),
  });

  return yield* Effect.acquireRelease(Effect.succeed(service), () =>
    Effect.gen(function* () {
      for (const subscriber of subscribers) {
        yield* Queue.shutdown(subscriber);
      }
      subscribers.clear();
    }),
  );
});

export class RuntimeEventBus extends Context.Service<
  RuntimeEventBus,
  {
    readonly publish: (event: RuntimeEvent) => Effect.Effect<void>;
    readonly subscribe: Effect.Effect<RuntimeEventSubscription>;
  }
>()('isagi/runtime/platform/events/RuntimeEventBus') {
  static readonly layer = Layer.effect(RuntimeEventBus, make);
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
