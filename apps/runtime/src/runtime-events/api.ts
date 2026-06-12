import { Effect, Either, Schema, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import {
  apiBasePath,
  runtimeEventSchema,
  runtimeEventsWebSocketEndpoint,
  type RuntimeEvent,
} from '@isagi/contracts';

import { isAllowedRuntimeOrigin } from '../lib/security/origin.js';
import type { RuntimeServices } from '../runtime.layer.js';
import { RuntimeEventBus } from './event-bus.js';

const runWithRuntime =
  (runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>) =>
  <A>(effect: Effect.Effect<A, unknown, RuntimeServices>) =>
    runtime.runPromise(effect);

export function registerRuntimeEventsApi(
  fastify: FastifyInstance,
  runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>,
) {
  const run = runWithRuntime(runtime);

  fastify.get(
    `${apiBasePath}${runtimeEventsWebSocketEndpoint.path}`,
    {
      websocket: true,
      preValidation: (request, reply, done) => {
        const origin = request.headers.origin;
        if (!isAllowedRuntimeOrigin(Array.isArray(origin) ? origin[0] : origin)) {
          reply.code(403).send('Forbidden');
          return;
        }
        done();
      },
    },
    (socket) => {
      let closed = false;
      let unsubscribe = () => {};

      const send = (event: RuntimeEvent) => {
        if (socket.readyState !== 1) {
          return false;
        }

        try {
          const encoded = Schema.decodeUnknownSync(runtimeEventSchema)(event);
          socket.send(JSON.stringify(encoded));
          return true;
        } catch (error: unknown) {
          console.error('[runtime] Runtime event websocket encoding failed', error);
          socket.close();
          return false;
        }
      };

      socket.once('close', () => {
        closed = true;
        unsubscribe();
      });

      void run(
        Effect.gen(function* () {
          const eventBus = yield* RuntimeEventBus;
          return yield* eventBus.subscribe;
        }).pipe(Effect.either),
      )
        .then((subscriptionResult) => {
          if (Either.isLeft(subscriptionResult)) {
            console.error(
              '[runtime] Runtime event websocket subscribe failed',
              subscriptionResult.left,
            );
            socket.close();
            return;
          }

          const subscription = subscriptionResult.right;
          unsubscribe = () => {
            void run(subscription.unsubscribe);
          };
          if (closed) {
            unsubscribe();
            return;
          }

          const pump = (): void => {
            if (closed) {
              return;
            }

            void run(subscription.take.pipe(Effect.either)).then(
              (eventResult) => {
                if (closed) {
                  return;
                }
                if (Either.isLeft(eventResult)) {
                  console.error(
                    '[runtime] Runtime event websocket receive failed',
                    eventResult.left,
                  );
                  socket.close();
                  return;
                }
                if (send(eventResult.right)) {
                  pump();
                }
              },
              (error: unknown) => {
                if (closed) {
                  return;
                }
                console.error('[runtime] Runtime event websocket failed', error);
                socket.close();
              },
            );
          };

          pump();
        })
        .catch((error: unknown) => {
          console.error('[runtime] Runtime event websocket failed', error);
          socket.close();
        });
    },
  );
}
