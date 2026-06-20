import { Deferred, Effect, Either, Queue } from 'effect';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  apiBasePath,
  type PtyWebSocketInputMessage,
  type PtyWebSocketOutputMessage,
} from '@isagi/contracts';

import { isAllowedRuntimeOrigin } from '../lib/security/origin.js';
import type { RuntimeServices } from '../runtime.layer.js';
import { PtyService, type PtyAttachment, type PtyAttachmentPlan } from './pty.service.js';

type RuntimeRunner = <A>(
  effect: Effect.Effect<A, unknown, RuntimeServices>,
  options?: { readonly signal?: AbortSignal | undefined },
) => Promise<A>;

interface SocketLike {
  readonly readyState: number;
  readonly send: (data: string) => void;
  readonly close: () => void;
  readonly once: (event: 'close', listener: () => void) => void;
  readonly on: (event: 'message', listener: (raw: Buffer) => void) => void;
  readonly off: (event: 'message', listener: (raw: Buffer) => void) => void;
}

export interface PtyStreamSocketControls {
  readonly send: (message: PtyWebSocketOutputMessage) => void;
  readonly close: () => void;
}

export interface PtyStreamAttachedControls extends PtyStreamSocketControls {
  readonly detach: Effect.Effect<void, never>;
}

export interface PtyStreamStrategy<Target> {
  readonly path: string;
  readonly logLabel: string;
  readonly resolveTarget: (
    request: FastifyRequest,
  ) => Effect.Effect<Target & { readonly ptyProcessId: number }, unknown, RuntimeServices>;
  readonly preamble: (input: {
    readonly target: Target & { readonly ptyProcessId: number };
    readonly plan: PtyAttachmentPlan;
  }) => PtyWebSocketOutputMessage;
  readonly decodeClientMessage: (raw: string) => PtyWebSocketInputMessage | null;
  readonly handleClientMessage: (input: {
    readonly target: Target & { readonly ptyProcessId: number };
    readonly attachmentId: symbol | null;
    readonly message: PtyWebSocketInputMessage;
  }) => Effect.Effect<void, unknown, RuntimeServices>;
  readonly beforeAttach: (
    target: Target & { readonly ptyProcessId: number },
  ) => Effect.Effect<void, unknown, RuntimeServices>;
  readonly registerAttachment: (input: {
    readonly target: Target & { readonly ptyProcessId: number };
    readonly attachment: PtyAttachment;
    readonly controls: PtyStreamAttachedControls;
  }) => Effect.Effect<() => void, unknown, RuntimeServices>;
  readonly mapError: (error: unknown) => {
    readonly code: PtyWebSocketOutputMessage extends infer Message
      ? Message extends { readonly type: 'error'; readonly code: infer Code }
        ? Code
        : never
      : never;
    readonly message?: string;
  };
}

export function registerPtyStreamRoute<Target>(
  fastify: FastifyInstance,
  run: RuntimeRunner,
  strategy: PtyStreamStrategy<Target>,
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

function runConnection<Target>(
  socket: SocketLike,
  request: FastifyRequest,
  strategy: PtyStreamStrategy<Target>,
) {
  return Effect.gen(function* () {
    let closed = false;
    const closedSignal = yield* Deferred.make<void>();
    const ready = yield* Deferred.make<{
      readonly target: Target & { readonly ptyProcessId: number };
      readonly attachmentId: symbol | null;
    }>();
    const clientMessages = yield* Queue.unbounded<PtyWebSocketInputMessage>();

    socket.once('close', () => {
      closed = true;
      void Effect.runPromise(Deferred.succeed(closedSignal, undefined));
    });

    const onMessage = (raw: Buffer) => {
      if (closed) return;
      const parsed = strategy.decodeClientMessage(raw.toString());
      if (!parsed) {
        send(socket, { type: 'error', code: 'invalid_message' });
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

    yield* processClientMessages(strategy, clientMessages, ready, (message) =>
      send(socket, message),
    ).pipe(Effect.forkScoped);

    const targetResult = yield* strategy.resolveTarget(request).pipe(Effect.either);
    if (Either.isLeft(targetResult)) {
      closeWithMappedError(socket, strategy, strategy.logLabel, targetResult.left);
      return yield* Deferred.await(closedSignal);
    }

    const target = targetResult.right;
    const pty = yield* PtyService;
    const planResult = yield* pty
      .getAttachmentPlan({ ptyProcessId: target.ptyProcessId })
      .pipe(Effect.either);
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
    send(socket, strategy.preamble({ target, plan }));
    if (closed) return;

    const replayResult = yield* pty
      .replay({
        session: plan.session,
        bytes: plan.replayBytes,
        send: (message) => send(socket, message),
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

    if (!plan.live) {
      yield* Deferred.succeed(ready, { target, attachmentId: null });
      return yield* Deferred.await(closedSignal);
    }

    const attachResult = yield* Effect.gen(function* () {
      yield* strategy.beforeAttach(target);
      const attachment = yield* pty.attach({
        ptyProcessId: target.ptyProcessId,
        send: (message) => send(socket, message),
      });
      const detach = makeIdempotentEffect(attachment.detach);
      yield* Effect.addFinalizer(() => detach());
      const release = yield* strategy.registerAttachment({
        target,
        attachment,
        controls: {
          send: (message) => send(socket, message),
          close: () => socket.close(),
          detach: detach(),
        },
      });
      yield* Effect.addFinalizer(() => Effect.sync(release));
      return attachment;
    }).pipe(Effect.either);

    if (Either.isLeft(attachResult)) {
      closeWithMappedError(
        socket,
        strategy,
        `${strategy.logLabel} live attach failed`,
        attachResult.left,
      );
      return yield* Deferred.await(closedSignal);
    }

    yield* Deferred.succeed(ready, {
      target,
      attachmentId: attachResult.right.attachmentId,
    });
    return yield* Deferred.await(closedSignal);
  });
}

function processClientMessages<Target>(
  strategy: PtyStreamStrategy<Target>,
  clientMessages: Queue.Queue<PtyWebSocketInputMessage>,
  ready: Deferred.Deferred<
    {
      readonly target: Target & { readonly ptyProcessId: number };
      readonly attachmentId: symbol | null;
    },
    never
  >,
  sendMessage: (message: PtyWebSocketOutputMessage) => void,
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

function closeWithMappedError<Target>(
  socket: SocketLike,
  strategy: PtyStreamStrategy<Target>,
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

function send(
  socket: { readonly readyState: number; readonly send: (data: string) => void },
  message: PtyWebSocketOutputMessage,
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
