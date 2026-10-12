import { Cause, Effect, Option, Schema, Stream } from 'effect';
import type { FastifyInstance } from 'fastify';

import {
  apiBasePath,
  runtimeEventInputMessageSchema,
  runtimeEventSchema,
  runtimeEventsWebSocketEndpoint,
  type RuntimeEvent,
  type RuntimeEventInputMessage,
} from '@isagi/contracts';

import { AgentSessionAttentionProjection } from '../environment/index.js';
import { nextRuntimeEventEnvelope, RuntimeEvents } from '../platform/events/index.js';
import {
  acquireWsConnection,
  enforceRuntimeWebSocketOrigin,
  type RouteRuntime,
  type WebSocketLike,
  type WsConnection,
} from '../platform/http/index.js';
import type { DatabaseError } from '../platform/persistence/index.js';
import { WorkflowEngine } from '../workflows/index.js';

/** The services the runtime events socket uses. */
type RuntimeEventsRouteServices = RuntimeEvents | AgentSessionAttentionProjection | WorkflowEngine;

/** The runtime-events module's route: the public runtime event socket. It has no module layer of its own. */
export function registerRuntimeEventsRoutes(
  fastify: FastifyInstance,
  runtime: RouteRuntime<RuntimeEventsRouteServices>,
) {
  fastify.get(
    `${apiBasePath}${runtimeEventsWebSocketEndpoint.path}`,
    {
      websocket: true,
      preValidation: enforceRuntimeWebSocketOrigin,
    },
    (socket) => {
      runtime.runFork(Effect.scoped(streamRuntimeEvents(socket)));
    },
  );
}

/**
 * One events connection, for as long as its socket is open.
 *
 * The bus subscription is taken before anything else can happen, and lives in the connection's scope: when the client
 * closes the socket (or the connection fiber is interrupted) the scope closes, which removes the subscriber and closes
 * the socket if it is still open. Events are sent in publish order; client messages are answered in arrival order.
 */
const streamRuntimeEvents = Effect.fn('runtimeEvents.connection')(function* (
  socket: WebSocketLike,
) {
  const ws = yield* acquireWsConnection(socket);
  const bus = yield* RuntimeEvents;
  const events = yield* bus.subscribe;

  yield* events.pipe(
    Stream.runForEach((event) =>
      Schema.decodeUnknownEffect(runtimeEventSchema)(event).pipe(Effect.flatMap(ws.send)),
    ),
    // An event the contract rejects, or a defect sending it, ends the connection; the client reconnects and re-reads.
    closeOnFailure(ws, 'Runtime event websocket delivery failed'),
    Effect.forkScoped,
  );

  yield* ws.incoming.pipe(
    Stream.runForEach((raw) => answerClientMessage(ws, raw)),
    Effect.forkScoped,
  );

  yield* ws.closed;
});

function answerClientMessage(ws: WsConnection, raw: string) {
  const message = decodeClientMessage(raw);
  if (Option.isNone(message)) {
    return Effect.logWarning('Runtime event websocket received invalid client message');
  }
  return handleClientMessage(message.value).pipe(
    Effect.flatMap(ws.send),
    closeOnFailure(ws, 'Runtime event websocket client message failed'),
  );
}

/**
 * Ends the connection when one of its fibers fails or hits a defect: logs the cause and closes the socket, so the
 * client sees the close, reconnects and re-reads instead of waiting on a socket that no longer answers. A forked fiber's
 * failure is otherwise invisible. Interruption (the connection's scope closing) passes through untouched.
 */
function closeOnFailure(ws: WsConnection, message: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logError(message, cause).pipe(Effect.andThen(ws.close)),
      ),
    );
}

function decodeClientMessage(raw: string): Option.Option<RuntimeEventInputMessage> {
  try {
    return Schema.decodeUnknownOption(runtimeEventInputMessageSchema)(JSON.parse(raw));
  } catch {
    return Option.none();
  }
}

function handleClientMessage(
  message: RuntimeEventInputMessage,
): Effect.Effect<RuntimeEvent, DatabaseError, RuntimeEventsRouteServices> {
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
    case 'workflow_run_snapshot_requested':
      return Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        const summaries = yield* engine.listAttachedSummaries;
        return {
          ...nextRuntimeEventEnvelope(),
          type: 'workflow_run_snapshot',
          payload: { summaries: [...summaries] },
        } satisfies RuntimeEvent;
      });
  }
}
