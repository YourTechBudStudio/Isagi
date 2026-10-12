import { Cause, Effect, Fiber, Queue, Result, Stream } from 'effect';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  apiBasePath,
  type PtyStreamErrorCode,
  type PtyStreamErrorMessage,
  type PtyStreamOutputMessageSet,
  type PtyWebSocketInputMessage,
} from '@isagi/contracts';

import { describeOperationalCause } from '../platform/diagnostics/index.js';
import {
  acquireWsConnection,
  enforceRuntimeWebSocketOrigin,
  errorMessage,
  type RouteRuntime,
  type WebSocketLike,
  type WsConnection,
} from '../platform/http/index.js';
import {
  PtyService,
  type PtyAttachError,
  type PtyAttachment,
  type PtyAttachmentMode,
  type PtyAttachmentPlan,
} from './service.js';

type StreamSocketMessage<Preamble extends { readonly type: string }> =
  | Preamble
  | PtyStreamOutputMessageSet
  | PtyStreamErrorMessage;

/** What a strategy may do to one connection's socket. Both are no-ops once the socket is closing. */
export interface PtyStreamSocketControls<Preamble extends { readonly type: string }> {
  readonly send: (message: StreamSocketMessage<Preamble>) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

export interface PtyStreamAttachedControls<
  Preamble extends { readonly type: string },
> extends PtyStreamSocketControls<Preamble> {
  /** Ends this connection's attachment now, ahead of its scope (a displaced or moved viewer). Idempotent. */
  readonly detach: Effect.Effect<void>;
}

type StreamTarget<Target> = Target & { readonly ptyProcessId: number | null };
type LiveTarget<Target> = Target & { readonly ptyProcessId: number };

/**
 * How one kind of PTY socket resolves its process and talks to its client.
 *
 * `E` is everything the strategy's own effects can fail with; `mapError` maps it, plus the route's own PTY failures
 * (`PtyAttachError`), to the socket's error frame. `R` is the services those effects need, beyond `PtyService`, which
 * the route itself uses.
 */
export interface PtyStreamStrategy<Target, Preamble extends { readonly type: string }, E, R> {
  readonly path: string;
  readonly logLabel: string;
  readonly mode: PtyAttachmentMode;
  readonly closeOnExit?: boolean | undefined;
  readonly closeOnReplayOnly?: boolean | undefined;
  readonly closeOnClientError?: boolean | undefined;
  readonly resolveTarget: (request: FastifyRequest) => Effect.Effect<StreamTarget<Target>, E, R>;
  readonly preamble: (input: {
    readonly target: StreamTarget<Target>;
    readonly plan: PtyAttachmentPlan | null;
  }) => Preamble;
  readonly decodeClientMessage: (raw: string) => PtyWebSocketInputMessage | null;
  readonly handleClientMessage: (input: {
    readonly target: StreamTarget<Target>;
    readonly attachmentId: symbol | null;
    readonly message: PtyWebSocketInputMessage;
  }) => Effect.Effect<void, E, R>;
  readonly beforeAttach: (target: LiveTarget<Target>) => Effect.Effect<void, E, R>;
  readonly recoverAttachFailure?: (input: {
    readonly target: LiveTarget<Target>;
    readonly cause: E | PtyAttachError;
  }) => Effect.Effect<StreamTarget<Target> | null, E, R>;
  readonly supersede: (target: LiveTarget<Target>) => boolean;
  readonly displace: (input: {
    readonly target: LiveTarget<Target>;
    readonly controls: PtyStreamAttachedControls<Preamble>;
  }) => Effect.Effect<void> | undefined;
  readonly registerAttachment: (input: {
    readonly target: LiveTarget<Target>;
    readonly attachment: PtyAttachment;
    readonly controls: PtyStreamAttachedControls<Preamble>;
  }) => Effect.Effect<() => void, E, R>;
  readonly mapError: (error: E | PtyAttachError) => {
    readonly code: PtyStreamErrorCode;
    readonly message?: string;
  };
}

/** The client may send once its connection is ready: after the replay, with the live attachment (if any) in place. */
interface ReadyConnection<Target> {
  readonly target: StreamTarget<Target>;
  readonly attachmentId: symbol | null;
}

/**
 * Registers a PTY WebSocket route. Each connection is one fiber on the route runtime, scoped to its socket: the client
 * closing the socket, or the runtime shutting down, closes the scope, which detaches the PTY attachment, stops every
 * fiber the connection started and closes the socket if it is still open.
 */
export function registerPtyStreamRoute<Target, Preamble extends { readonly type: string }, E, R>(
  fastify: FastifyInstance,
  runtime: RouteRuntime<NoInfer<R> | PtyService>,
  strategy: PtyStreamStrategy<Target, Preamble, E, R>,
) {
  fastify.get(
    `${apiBasePath}${strategy.path}`,
    {
      websocket: true,
      preValidation: enforceRuntimeWebSocketOrigin,
    },
    (socket, request) => {
      runtime.runFork(Effect.scoped(runConnection(socket, request, strategy)));
    },
  );
}

/**
 * One connection, for as long as its socket is open.
 *
 * Client frames are decoded as they arrive, so a malformed one is answered at once; valid ones wait in a queue until
 * the connection is ready, then apply in arrival order. The rest of the connection (target, preamble, replay, live
 * attach) runs in its own fiber, so a socket that closes mid-replay interrupts the replay rather than waiting for it.
 */
const runConnection = Effect.fn('ptyStream.connection')(function* <
  Target,
  Preamble extends { readonly type: string },
  E,
  R,
>(
  socket: WebSocketLike,
  request: FastifyRequest,
  strategy: PtyStreamStrategy<Target, Preamble, E, R>,
) {
  const ws = yield* acquireWsConnection(socket);
  const clientMessages = yield* Queue.unbounded<PtyWebSocketInputMessage>();

  yield* ws.incoming.pipe(
    Stream.runForEach((raw) => {
      const message = strategy.decodeClientMessage(raw);
      return message === null
        ? rejectClientMessage(ws, strategy, { type: 'error', code: 'invalid_message' })
        : Queue.offer(clientMessages, message);
    }),
    forkSupervised(ws, strategy),
  );

  yield* streamProcess(ws, request, strategy).pipe(
    Effect.flatMap((ready) =>
      ready === null
        ? Effect.void
        : Stream.fromQueue(clientMessages).pipe(
            Stream.runForEach((message) => handleClientMessage(ws, strategy, ready, message)),
            forkSupervised(ws, strategy),
          ),
    ),
    forkSupervised(ws, strategy),
  );

  yield* ws.closed;
});

/**
 * Resolves the target, sends the preamble, replays and attaches. Returns the ready connection, or `null` when it
 * ended the connection with an error frame. Live output reaches the socket only after the replay, in order.
 */
const streamProcess = Effect.fnUntraced(function* <
  Target,
  Preamble extends { readonly type: string },
  E,
  R,
>(ws: WsConnection, request: FastifyRequest, strategy: PtyStreamStrategy<Target, Preamble, E, R>) {
  const pty = yield* PtyService;
  const sendOutput = outputSender(ws, strategy);

  const targetResult = yield* strategy.resolveTarget(request).pipe(Effect.result);
  if (Result.isFailure(targetResult)) {
    return yield* closeWithMappedError(ws, strategy, strategy.logLabel, targetResult.failure);
  }
  const target = targetResult.success;

  const planResult =
    target.ptyProcessId === null
      ? Result.succeed(null)
      : yield* pty.getAttachmentPlan({ ptyProcessId: target.ptyProcessId }).pipe(Effect.result);
  if (Result.isFailure(planResult)) {
    return yield* closeWithMappedError(
      ws,
      strategy,
      `${strategy.logLabel} attachment plan failed`,
      planResult.failure,
    );
  }
  const plan = planResult.success;
  yield* ws.send(strategy.preamble({ target, plan }));

  if (target.ptyProcessId === null || !plan?.live) {
    if (plan) {
      const replayResult = yield* replayFrames(sendOutput, (send) =>
        pty.replay({ session: plan.session, bytes: plan.replayBytes, send }),
      );
      if (Result.isFailure(replayResult)) {
        return yield* closeWithMappedError(
          ws,
          strategy,
          `${strategy.logLabel} replay failed`,
          replayResult.failure,
        );
      }
    }
    return yield* replayOnlyReady(ws, strategy, target);
  }

  const liveTarget = { ...target, ptyProcessId: target.ptyProcessId };
  const live = yield* Queue.unbounded<PtyStreamOutputMessageSet>();
  const forwardLive = Stream.fromQueue(live).pipe(
    Stream.runForEach(sendOutput),
    forkSupervised(ws, strategy),
  );

  // A backend without a byte cursor cannot say where its replay ends, so it replays first and goes live from the
  // attach.
  if (plan.replayBytes === null) {
    const replayResult = yield* replayFrames(sendOutput, (send) =>
      pty.replay({ session: plan.session, bytes: plan.replayBytes, send }),
    );
    if (Result.isFailure(replayResult)) {
      return yield* closeWithMappedError(
        ws,
        strategy,
        `${strategy.logLabel} replay failed`,
        replayResult.failure,
      );
    }
  }

  const attachResult = yield* attachLive(ws, strategy, liveTarget, live).pipe(Effect.result);
  if (Result.isFailure(attachResult)) {
    const recovered = yield* recoverReplayOnlyAfterAttachFailure(
      ws,
      strategy,
      liveTarget,
      attachResult.failure,
    );
    if (recovered?.status === 'recovered') {
      return yield* replayOnlyReady(ws, strategy, recovered.target);
    }
    if (recovered?.status === 'closed') return null;
    return yield* closeWithMappedError(
      ws,
      strategy,
      `${strategy.logLabel} live attach failed`,
      attachResult.failure,
    );
  }
  const attachment = attachResult.success;

  // Output produced while the replay runs waits in `live`, so the client sees the log up to the attach instant and
  // then everything after it, with no gap and no duplicate.
  if (plan.replayBytes !== null && attachment.replayBytes !== null) {
    const replayResult = yield* replayFrames(sendOutput, (send) =>
      pty.replay({ session: plan.session, bytes: attachment.replayBytes, send }),
    );
    if (Result.isFailure(replayResult)) {
      return yield* closeWithMappedError(
        ws,
        strategy,
        `${strategy.logLabel} replay failed`,
        replayResult.failure,
      );
    }
  }

  yield* forwardLive;
  return { target, attachmentId: attachment.attachmentId } satisfies ReadyConnection<Target>;
});

const replayOnlyReady = Effect.fnUntraced(function* <
  Target,
  Preamble extends { readonly type: string },
  E,
  R,
>(
  ws: WsConnection,
  strategy: PtyStreamStrategy<Target, Preamble, E, R>,
  target: StreamTarget<Target>,
) {
  if (strategy.closeOnReplayOnly) yield* ws.close;
  return { target, attachmentId: null } satisfies ReadyConnection<Target>;
});

const recoverReplayOnlyAfterAttachFailure = Effect.fnUntraced(function* <
  Target,
  Preamble extends { readonly type: string },
  E,
  R,
>(
  ws: WsConnection,
  strategy: PtyStreamStrategy<Target, Preamble, E, R>,
  target: LiveTarget<Target>,
  cause: E | PtyAttachError,
) {
  if (!strategy.recoverAttachFailure) return null;
  const pty = yield* PtyService;
  const targetResult = yield* strategy.recoverAttachFailure({ target, cause }).pipe(Effect.result);
  if (Result.isFailure(targetResult) || targetResult.success === null) return null;

  const recoveredTarget = targetResult.success;
  const planResult =
    recoveredTarget.ptyProcessId === null
      ? Result.succeed(null)
      : yield* pty
          .getAttachmentPlan({ ptyProcessId: recoveredTarget.ptyProcessId })
          .pipe(Effect.result);
  if (Result.isFailure(planResult) || planResult.success?.live) return null;

  const plan = planResult.success;
  yield* ws.send(strategy.preamble({ target: recoveredTarget, plan }));
  if (plan) {
    const replayResult = yield* replayFrames(outputSender(ws, strategy), (send) =>
      pty.replay({ session: plan.session, bytes: plan.replayBytes, send }),
    );
    if (Result.isFailure(replayResult)) {
      yield* closeWithMappedError(
        ws,
        strategy,
        `${strategy.logLabel} replay failed after attach recovery`,
        replayResult.failure,
      );
      return { status: 'closed' as const };
    }
  }
  return { status: 'recovered' as const, target: recoveredTarget };
});

/**
 * Attaches for the life of the connection's scope. Live output goes to `live` from the attach instant; the scope
 * closing detaches it (the attachment is scoped) and unregisters it from the strategy.
 */
const attachLive = Effect.fnUntraced(function* <
  Target,
  Preamble extends { readonly type: string },
  E,
  R,
>(
  ws: WsConnection,
  strategy: PtyStreamStrategy<Target, Preamble, E, R>,
  target: LiveTarget<Target>,
  live: Queue.Enqueue<PtyStreamOutputMessageSet>,
) {
  const pty = yield* PtyService;
  yield* strategy.beforeAttach(target);
  const attachment = yield* pty.attach({
    ptyProcessId: target.ptyProcessId,
    mode: strategy.mode,
    supersede: strategy.supersede(target),
    send: (message) => {
      Queue.offerUnsafe(live, message);
    },
    displace: (attached) =>
      strategy.displace({
        target,
        controls: { send: ws.send, close: ws.close, detach: attached.detach },
      }),
  });
  const release = yield* strategy
    .registerAttachment({
      target,
      attachment,
      controls: { send: ws.send, close: ws.close, detach: attachment.detach },
    })
    .pipe(Effect.tapError(() => attachment.detach));
  yield* Effect.addFinalizer(() => Effect.sync(release));
  return attachment;
});

/**
 * Runs one replay. `PtyService.replay` hands frames to a synchronous callback; a child fiber writes them to the
 * socket in order while the replay runs, and every frame is written before this returns. Interrupting it (the socket
 * closed) stops the replay and its writer together.
 */
const replayFrames = Effect.fnUntraced(function* <E, R>(
  sendOutput: (message: PtyStreamOutputMessageSet) => Effect.Effect<void>,
  replay: (send: (message: PtyStreamOutputMessageSet) => void) => Effect.Effect<void, E, R>,
) {
  const frames = yield* Queue.unbounded<PtyStreamOutputMessageSet, Cause.Done>();
  const writer = yield* Stream.fromQueue(frames).pipe(
    Stream.runForEach(sendOutput),
    Effect.forkChild,
  );
  const result = yield* replay((message) => {
    Queue.offerUnsafe(frames, message);
  }).pipe(Effect.ensuring(Queue.end(frames)), Effect.result);
  yield* Fiber.join(writer);
  return result;
});

/** Applies one client message; a failure is answered with the strategy's error frame. */
function handleClientMessage<Target, Preamble extends { readonly type: string }, E, R>(
  ws: WsConnection,
  strategy: PtyStreamStrategy<Target, Preamble, E, R>,
  ready: ReadyConnection<Target>,
  message: PtyWebSocketInputMessage,
) {
  return strategy
    .handleClientMessage({ ...ready, message })
    .pipe(
      Effect.catch((error) =>
        rejectClientMessage(ws, strategy, { type: 'error', ...strategy.mapError(error) }),
      ),
    );
}

/**
 * Forks a part of the connection into its scope. A defect in any part is reported as a crash, which closes the socket
 * and so ends the connection.
 */
function forkSupervised<Target, Preamble extends { readonly type: string }, E, R>(
  ws: WsConnection,
  strategy: PtyStreamStrategy<Target, Preamble, E, R>,
) {
  return <A, R2>(effect: Effect.Effect<A, never, R2>) =>
    effect.pipe(
      Effect.catchDefect((defect) => reportCrash(ws, strategy, defect)),
      Effect.forkScoped,
      Effect.asVoid,
    );
}

function outputSender<Target, Preamble extends { readonly type: string }, E, R>(
  ws: WsConnection,
  strategy: PtyStreamStrategy<Target, Preamble, E, R>,
) {
  return (message: PtyStreamOutputMessageSet) =>
    message.type === 'exit' && strategy.closeOnExit
      ? Effect.andThen(ws.send(message), ws.close)
      : ws.send(message);
}

function rejectClientMessage<Target, Preamble extends { readonly type: string }, E, R>(
  ws: WsConnection,
  strategy: PtyStreamStrategy<Target, Preamble, E, R>,
  message: PtyStreamErrorMessage,
) {
  const send = ws.send(message);
  return strategy.closeOnClientError ? Effect.andThen(send, ws.close) : send;
}

/** Ends the connection with the strategy's error frame for `error`; the scope closes when the socket does. */
function closeWithMappedError<Target, Preamble extends { readonly type: string }, E, R>(
  ws: WsConnection,
  strategy: PtyStreamStrategy<Target, Preamble, E, R>,
  operation: string,
  error: E | PtyAttachError,
) {
  const mapped = strategy.mapError(error);
  return Effect.logWarning(`[runtime] ${operation}`).pipe(
    Effect.annotateLogs({
      errorCode: mapped.code,
      ...(mapped.message === undefined ? {} : { errorMessage: mapped.message }),
      cause: describeOperationalCause(error),
    }),
    Effect.andThen(ws.send({ type: 'error', ...mapped })),
    Effect.andThen(ws.close),
    Effect.as(null),
  );
}

/** A defect in a connection is reported once, to the log and to the client, and ends the connection. */
function reportCrash<Target, Preamble extends { readonly type: string }, E, R>(
  ws: WsConnection,
  strategy: PtyStreamStrategy<Target, Preamble, E, R>,
  defect: unknown,
) {
  const message = errorMessage(defect);
  return Effect.logError(`[runtime] ${strategy.logLabel} crashed`, Cause.die(defect)).pipe(
    Effect.annotateLogs({ errorCode: 'unknown', errorMessage: message }),
    Effect.andThen(ws.send({ type: 'error', code: 'unknown', message })),
    Effect.andThen(ws.close),
  );
}
