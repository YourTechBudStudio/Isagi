import { Deferred, Effect, Either, Queue } from 'effect';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  apiBasePath,
  type PtyStreamErrorCode,
  type PtyStreamErrorMessage,
  type PtyStreamOutputMessageSet,
  type PtyWebSocketInputMessage,
} from '@isagi/contracts';

import { isAllowedRuntimeOrigin } from '../lib/security/origin.js';
import type { RuntimeServices } from '../runtime.layer.js';
import {
  PtyService,
  type PtyAttachment,
  type PtyAttachmentMode,
  type PtyAttachmentPlan,
} from './pty.service.js';

type RuntimeRunner = <A>(
  effect: Effect.Effect<A, unknown, RuntimeServices>,
  options?: { readonly signal?: AbortSignal | undefined },
) => Promise<A>;

type StreamSocketMessage<Preamble extends { readonly type: string }> =
  | Preamble
  | PtyStreamOutputMessageSet
  | PtyStreamErrorMessage;

interface SocketLike {
  readonly readyState: number;
  readonly send: (data: string) => void;
  readonly close: () => void;
  readonly once: (event: 'close', listener: () => void) => void;
  readonly on: (event: 'message', listener: (raw: Buffer) => void) => void;
  readonly off: (event: 'message', listener: (raw: Buffer) => void) => void;
}

export interface PtyStreamSocketControls<Preamble extends { readonly type: string }> {
  readonly send: (message: StreamSocketMessage<Preamble>) => void;
  readonly close: () => void;
}

export interface PtyStreamAttachedControls<
  Preamble extends { readonly type: string },
> extends PtyStreamSocketControls<Preamble> {
  readonly detach: Effect.Effect<void, never>;
}

export interface PtyStreamStrategy<Target, Preamble extends { readonly type: string }> {
  readonly path: string;
  readonly logLabel: string;
  readonly mode: PtyAttachmentMode;
  readonly closeOnExit?: boolean | undefined;
  readonly closeOnReplayOnly?: boolean | undefined;
  readonly closeOnClientError?: boolean | undefined;
  readonly resolveTarget: (
    request: FastifyRequest,
  ) => Effect.Effect<Target & { readonly ptyProcessId: number | null }, unknown, RuntimeServices>;
  readonly preamble: (input: {
    readonly target: Target & { readonly ptyProcessId: number | null };
    readonly plan: PtyAttachmentPlan | null;
  }) => Preamble;
  readonly decodeClientMessage: (raw: string) => PtyWebSocketInputMessage | null;
  readonly handleClientMessage: (input: {
    readonly target: Target & { readonly ptyProcessId: number | null };
    readonly attachmentId: symbol | null;
    readonly message: PtyWebSocketInputMessage;
  }) => Effect.Effect<void, unknown, RuntimeServices>;
  readonly beforeAttach: (
    target: Target & { readonly ptyProcessId: number },
  ) => Effect.Effect<void, unknown, RuntimeServices>;
  readonly recoverAttachFailure?: (input: {
    readonly target: Target & { readonly ptyProcessId: number };
    readonly cause: unknown;
  }) => Effect.Effect<
    (Target & { readonly ptyProcessId: number | null }) | null,
    unknown,
    RuntimeServices
  >;
  readonly supersede: (target: Target & { readonly ptyProcessId: number }) => boolean;
  readonly displace: (input: {
    readonly target: Target & { readonly ptyProcessId: number };
    readonly controls: PtyStreamAttachedControls<Preamble>;
  }) => Effect.Effect<void, never> | undefined;
  readonly registerAttachment: (input: {
    readonly target: Target & { readonly ptyProcessId: number };
    readonly attachment: PtyAttachment;
    readonly controls: PtyStreamAttachedControls<Preamble>;
  }) => Effect.Effect<() => void, unknown, RuntimeServices>;
  readonly mapError: (error: unknown) => {
    readonly code: PtyStreamErrorCode;
    readonly message?: string;
  };
}

export function registerPtyStreamRoute<Target, Preamble extends { readonly type: string }>(
  fastify: FastifyInstance,
  run: RuntimeRunner,
  strategy: PtyStreamStrategy<Target, Preamble>,
) {
  fastify.get(
    `${apiBasePath}${strategy.path}`,
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
    (socket, request) => {
      const scoped = Effect.scoped(runConnection(socket, request, strategy));
      setImmediate(() => {
        void run(scoped).catch((error: unknown) => {
          const socketError = strategy.mapError(error);
          console.error(`[runtime] ${strategy.logLabel} crashed`, {
            errorCode: socketError.code,
            errorMessage: socketError.message,
            cause: error,
          });
          send(socket, { type: 'error', ...socketError });
          socket.close();
        });
      });
    },
  );
}

function runConnection<Target, Preamble extends { readonly type: string }>(
  socket: SocketLike,
  request: FastifyRequest,
  strategy: PtyStreamStrategy<Target, Preamble>,
) {
  return Effect.gen(function* () {
    let closed = false;
    const closedSignal = yield* Deferred.make<void>();
    const ready = yield* Deferred.make<{
      readonly target: Target & { readonly ptyProcessId: number | null };
      readonly attachmentId: symbol | null;
    }>();
    const clientMessages = yield* Queue.unbounded<PtyWebSocketInputMessage>();
    const liveBuffer: PtyStreamOutputMessageSet[] = [];
    let bufferingLive = false;

    socket.once('close', () => {
      closed = true;
      liveBuffer.splice(0);
      void Effect.runPromise(Deferred.succeed(closedSignal, undefined));
    });

    const sendMessage = (message: StreamSocketMessage<Preamble>) => {
      send(socket, message);
      if (message.type === 'exit' && strategy.closeOnExit) setImmediate(() => socket.close());
    };
    const sendLive = (message: PtyStreamOutputMessageSet) => {
      if (closed) return;
      if (bufferingLive) {
        liveBuffer.push(message);
        return;
      }
      sendMessage(message);
    };
    const flushLiveBuffer = () => {
      for (const message of liveBuffer.splice(0)) {
        if (closed) return;
        sendMessage(message);
        if (message.type === 'exit' && strategy.closeOnExit) return;
      }
    };

    const onMessage = (raw: Buffer) => {
      if (closed) return;
      const parsed = strategy.decodeClientMessage(raw.toString());
      if (!parsed) {
        send(socket, { type: 'error', code: 'invalid_message' });
        if (strategy.closeOnClientError) setImmediate(() => socket.close());
        return;
      }
      void Effect.runPromise(Queue.offer(clientMessages, parsed));
    };
    socket.on('message', onMessage);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        socket.off('message', onMessage);
      }),
    );
    yield* Effect.addFinalizer(() => Queue.shutdown(clientMessages));

    yield* processClientMessages(strategy, clientMessages, ready, (message) => {
      send(socket, message);
      if (strategy.closeOnClientError) setImmediate(() => socket.close());
    }).pipe(Effect.forkScoped);

    const targetResult = yield* strategy.resolveTarget(request).pipe(Effect.either);
    if (Either.isLeft(targetResult)) {
      closeWithMappedError(socket, strategy, strategy.logLabel, targetResult.left);
      return yield* Deferred.await(closedSignal);
    }

    const target = targetResult.right;
    const pty = yield* PtyService;
    const planResult =
      target.ptyProcessId === null
        ? Either.right(null)
        : yield* pty.getAttachmentPlan({ ptyProcessId: target.ptyProcessId }).pipe(Effect.either);
    if (Either.isLeft(planResult)) {
      closeWithMappedError(
        socket,
        strategy,
        `${strategy.logLabel} attachment plan failed`,
        planResult.left,
      );
      return yield* Deferred.await(closedSignal);
    }

    const plan = planResult.right;
    sendMessage(strategy.preamble({ target, plan }));
    if (closed) return;

    if (target.ptyProcessId === null || !plan?.live) {
      if (plan) {
        const replayResult = yield* pty
          .replay({
            session: plan.session,
            bytes: plan.replayBytes,
            send: (message) => sendMessage(message),
          })
          .pipe(Effect.either);
        if (Either.isLeft(replayResult)) {
          closeWithMappedError(
            socket,
            strategy,
            `${strategy.logLabel} replay failed`,
            replayResult.left,
          );
          return yield* Deferred.await(closedSignal);
        }
      }
      yield* Deferred.succeed(ready, { target, attachmentId: null });
      if (strategy.closeOnReplayOnly) setImmediate(() => socket.close());
      return yield* Deferred.await(closedSignal);
    }

    const liveTarget = { ...target, ptyProcessId: target.ptyProcessId };
    if (plan.replayBytes === null) {
      const replayResult = yield* pty
        .replay({
          session: plan.session,
          bytes: plan.replayBytes,
          send: (message) => sendMessage(message),
        })
        .pipe(Effect.either);
      if (Either.isLeft(replayResult)) {
        closeWithMappedError(
          socket,
          strategy,
          `${strategy.logLabel} replay failed`,
          replayResult.left,
        );
        return yield* Deferred.await(closedSignal);
      }

      const attachResult = yield* attachLive({
        socket,
        strategy,
        target: liveTarget,
        sendLive,
      }).pipe(Effect.either);
      if (Either.isLeft(attachResult)) {
        const recovered = yield* recoverReplayOnlyAfterAttachFailure({
          socket,
          strategy,
          target: liveTarget,
          cause: attachResult.left,
          sendMessage,
          closed: () => closed,
        });
        if (recovered?.status === 'recovered') {
          yield* Deferred.succeed(ready, { target: recovered.target, attachmentId: null });
          if (strategy.closeOnReplayOnly) setImmediate(() => socket.close());
          return yield* Deferred.await(closedSignal);
        }
        if (recovered?.status === 'closed') return yield* Deferred.await(closedSignal);
        closeWithMappedError(
          socket,
          strategy,
          `${strategy.logLabel} live attach failed`,
          attachResult.left,
        );
        return yield* Deferred.await(closedSignal);
      }

      const attachment = attachResult.right;
      yield* Deferred.succeed(ready, {
        target,
        attachmentId: attachment.attachmentId,
      });
      return yield* Deferred.await(closedSignal);
    }

    bufferingLive = true;
    const attachResult = yield* attachLive({
      socket,
      strategy,
      target: liveTarget,
      sendLive,
    }).pipe(Effect.either);

    if (Either.isLeft(attachResult)) {
      bufferingLive = false;
      liveBuffer.splice(0);
      const recovered = yield* recoverReplayOnlyAfterAttachFailure({
        socket,
        strategy,
        target: liveTarget,
        cause: attachResult.left,
        sendMessage,
        closed: () => closed,
      });
      if (recovered?.status === 'recovered') {
        yield* Deferred.succeed(ready, { target: recovered.target, attachmentId: null });
        if (strategy.closeOnReplayOnly) setImmediate(() => socket.close());
        return yield* Deferred.await(closedSignal);
      }
      if (recovered?.status === 'closed') return yield* Deferred.await(closedSignal);
      closeWithMappedError(
        socket,
        strategy,
        `${strategy.logLabel} live attach failed`,
        attachResult.left,
      );
      return yield* Deferred.await(closedSignal);
    }

    const attachment = attachResult.right;
    yield* Deferred.succeed(ready, {
      target,
      attachmentId: attachment.attachmentId,
    });

    if (attachment.replayBytes === null) {
      bufferingLive = false;
      flushLiveBuffer();
      return yield* Deferred.await(closedSignal);
    }

    const replayResult = yield* pty
      .replay({
        session: plan.session,
        bytes: attachment.replayBytes,
        send: (message) => sendMessage(message),
      })
      .pipe(Effect.either);
    bufferingLive = false;

    if (Either.isLeft(replayResult)) {
      closeWithMappedError(
        socket,
        strategy,
        `${strategy.logLabel} replay failed`,
        replayResult.left,
      );
      return yield* Deferred.await(closedSignal);
    }

    flushLiveBuffer();
    return yield* Deferred.await(closedSignal);
  });
}

function recoverReplayOnlyAfterAttachFailure<
  Target,
  Preamble extends { readonly type: string },
>(input: {
  readonly socket: SocketLike;
  readonly strategy: PtyStreamStrategy<Target, Preamble>;
  readonly target: Target & { readonly ptyProcessId: number };
  readonly cause: unknown;
  readonly sendMessage: (message: StreamSocketMessage<Preamble>) => void;
  readonly closed: () => boolean;
}) {
  return Effect.gen(function* () {
    if (!input.strategy.recoverAttachFailure) return null;
    const pty = yield* PtyService;
    const targetResult = yield* input.strategy
      .recoverAttachFailure({ target: input.target, cause: input.cause })
      .pipe(Effect.either);
    if (Either.isLeft(targetResult) || targetResult.right === null) return null;

    const recoveredTarget = targetResult.right;
    const planResult =
      recoveredTarget.ptyProcessId === null
        ? Either.right(null)
        : yield* pty
            .getAttachmentPlan({ ptyProcessId: recoveredTarget.ptyProcessId })
            .pipe(Effect.either);
    if (Either.isLeft(planResult) || planResult.right?.live) return null;

    const plan = planResult.right;
    input.sendMessage(input.strategy.preamble({ target: recoveredTarget, plan }));
    if (input.closed()) return { status: 'recovered' as const, target: recoveredTarget };

    if (plan) {
      const replayResult = yield* pty
        .replay({
          session: plan.session,
          bytes: plan.replayBytes,
          send: (message) => input.sendMessage(message),
        })
        .pipe(Effect.either);
      if (Either.isLeft(replayResult)) {
        closeWithMappedError(
          input.socket,
          input.strategy,
          `${input.strategy.logLabel} replay failed after attach recovery`,
          replayResult.left,
        );
        return { status: 'closed' as const };
      }
    }

    return { status: 'recovered' as const, target: recoveredTarget };
  });
}

function attachLive<Target, Preamble extends { readonly type: string }>(input: {
  readonly socket: SocketLike;
  readonly strategy: PtyStreamStrategy<Target, Preamble>;
  readonly target: Target & { readonly ptyProcessId: number };
  readonly sendLive: (message: PtyStreamOutputMessageSet) => void;
}) {
  return Effect.gen(function* () {
    const pty = yield* PtyService;
    yield* input.strategy.beforeAttach(input.target);
    const attachment = yield* pty.attach({
      ptyProcessId: input.target.ptyProcessId,
      mode: input.strategy.mode,
      supersede: input.strategy.supersede(input.target),
      send: input.sendLive,
      displace: (attached) =>
        input.strategy.displace({
          target: input.target,
          controls: {
            send: (message) => send(input.socket, message),
            close: () => input.socket.close(),
            detach: attached.detach,
          },
        }),
    });
    const detach = makeIdempotentEffect(attachment.detach);
    yield* Effect.addFinalizer(() => detach());
    const release = yield* input.strategy.registerAttachment({
      target: input.target,
      attachment,
      controls: {
        send: (message) => send(input.socket, message),
        close: () => input.socket.close(),
        detach: detach(),
      },
    });
    yield* Effect.addFinalizer(() => Effect.sync(release));
    return attachment;
  });
}

function processClientMessages<Target, Preamble extends { readonly type: string }>(
  strategy: PtyStreamStrategy<Target, Preamble>,
  clientMessages: Queue.Queue<PtyWebSocketInputMessage>,
  ready: Deferred.Deferred<
    {
      readonly target: Target & { readonly ptyProcessId: number | null };
      readonly attachmentId: symbol | null;
    },
    never
  >,
  sendMessage: (message: PtyStreamErrorMessage) => void,
) {
  return Effect.forever(
    Effect.gen(function* () {
      const message = yield* Queue.take(clientMessages);
      const attachment = yield* Deferred.await(ready);
      const result = yield* strategy
        .handleClientMessage({
          target: attachment.target,
          attachmentId: attachment.attachmentId,
          message,
        })
        .pipe(Effect.either);
      if (Either.isLeft(result)) {
        const error = strategy.mapError(result.left);
        sendMessage({ type: 'error', ...error });
      }
    }),
  );
}

function closeWithMappedError<Target, Preamble extends { readonly type: string }>(
  socket: SocketLike,
  strategy: PtyStreamStrategy<Target, Preamble>,
  operation: string,
  cause: unknown,
) {
  const error = strategy.mapError(cause);
  console.warn(`[runtime] ${operation}`, {
    errorCode: error.code,
    errorMessage: error.message,
    cause,
  });
  send(socket, { type: 'error', ...error });
  setImmediate(() => socket.close());
}

function send<Preamble extends { readonly type: string }>(
  socket: { readonly readyState: number; readonly send: (data: string) => void },
  message: StreamSocketMessage<Preamble>,
) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

function makeIdempotentEffect(effect: Effect.Effect<void, never>) {
  let done = false;
  return () =>
    Effect.gen(function* () {
      if (done) return;
      done = true;
      yield* effect;
    });
}
