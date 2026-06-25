import { Effect, Either, Schema, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import {
  apiBasePath,
  runtimeEventInputMessageSchema,
  runtimeEventSchema,
  runtimeEventsWebSocketEndpoint,
  type RuntimeEvent,
  type RuntimeEventInputMessage,
} from '@isagi/contracts';

import { AgentSessionAttentionProjection } from '../agent-sessions/index.js';
import { isAllowedRuntimeOrigin } from '../lib/security/origin.js';
import type { RuntimeServices } from '../runtime.layer.js';
import { WorkflowSurfaceProjection } from '../workflows/index.js';
import { nextRuntimeEventEnvelope, RuntimeEventBus } from './event-bus.js';

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
            void run(subscription.unsubscribe).catch((error: unknown) => {
              console.warn('[runtime] Runtime event websocket unsubscribe failed', error);
            });
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

      socket.on('message', (raw: Buffer) => {
        const message = decodeClientMessage(raw);
        if (!message) {
          console.warn('[runtime] Runtime event websocket received invalid client message');
          return;
        }
        void run(handleClientMessage(message)).then(
          (event) => {
            if (!closed) send(event);
          },
          (error: unknown) => {
            console.error('[runtime] Runtime event websocket client message failed', error);
            socket.close();
          },
        );
      });
    },
  );
}

function decodeClientMessage(raw: Buffer): RuntimeEventInputMessage | null {
  try {
    return Schema.decodeUnknownSync(runtimeEventInputMessageSchema)(JSON.parse(raw.toString()));
  } catch {
    return null;
  }
}

function handleClientMessage(
  message: RuntimeEventInputMessage,
): Effect.Effect<RuntimeEvent, unknown, RuntimeServices> {
  switch (message.type) {
    case 'attention_snapshot_requested':
      return Effect.gen(function* () {
        const attention = yield* AgentSessionAttentionProjection;
        const sources = yield* attention.listAttentionSources;
        return {
          ...nextRuntimeEventEnvelope(),
          type: 'attention_snapshot',
          payload: { sources: [...sources] },
        } satisfies RuntimeEvent;
      });
    case 'workflow_surface_snapshot_requested':
      return Effect.gen(function* () {
        const projection = yield* WorkflowSurfaceProjection;
        const summaries = yield* projection.listSummaries;
        return {
          ...nextRuntimeEventEnvelope(),
          type: 'workflow_surface_snapshot',
          payload: { summaries: [...summaries] },
        } satisfies RuntimeEvent;
      });
  }
}
