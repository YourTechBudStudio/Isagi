import { Context, Effect, Layer, Queue } from 'effect';

import type { RuntimeEvent } from '@isagi/contracts';

export interface RuntimeEventBusService {
  readonly publish: (event: RuntimeEvent) => Effect.Effect<void>;
  readonly subscribe: Effect.Effect<RuntimeEventSubscription>;
}

export interface RuntimeEventSubscription {
  readonly take: Effect.Effect<RuntimeEvent>;
  readonly unsubscribe: Effect.Effect<void>;
}

export const RuntimeEventBus = Context.GenericTag<RuntimeEventBusService>('isagi/RuntimeEventBus');

export const RuntimeEventBusLive = Layer.scoped(
  RuntimeEventBus,
  Effect.gen(function* () {
    const subscribers = new Set<Queue.Queue<RuntimeEvent>>();

    const service = {
      publish: (event) =>
        Effect.sync(() => {
          for (const subscriber of subscribers) {
            subscriber.unsafeOffer(event);
          }
        }),
      subscribe: Queue.unbounded<RuntimeEvent>().pipe(
        Effect.map((queue) => {
          subscribers.add(queue);
          return {
            take: queue.take,
            unsubscribe: Effect.sync(() => {
              subscribers.delete(queue);
            }).pipe(Effect.zipRight(queue.shutdown)),
          } satisfies RuntimeEventSubscription;
        }),
      ),
    } satisfies RuntimeEventBusService;

    return yield* Effect.acquireRelease(Effect.succeed(service), () =>
      Effect.gen(function* () {
        for (const subscriber of subscribers) {
          yield* subscriber.shutdown;
        }
        subscribers.clear();
      }),
    );
  }),
);

let eventCounter = 0;

export function nextRuntimeEventEnvelope() {
  eventCounter += 1;
  const occurredAt = new Date().toISOString();
  return {
    id: `evt_${Date.now()}_${eventCounter}`,
    occurredAt,
  };
}
