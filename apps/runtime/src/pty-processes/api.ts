import { Effect, Either, Schema, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import {
  agentSessionPtyWebSocketEndpoint,
  apiBasePath,
  ptyWebSocketInputMessageSchema,
  terminalSessionPtyWebSocketEndpoint,
  type PtyWebSocketErrorCode,
  type PtyWebSocketInputMessage,
  type PtyWebSocketOutputMessage,
} from '@isagi/contracts';

import { AgentSessionError, AgentSessionService } from '../agent-sessions/index.js';
import { HarnessAdapterError } from '../harness-adapters/index.js';
import { errorMessage } from '../lib/api/index.js';
import { isAllowedRuntimeOrigin } from '../lib/security/origin.js';
import { DatabaseError } from '../persistence/index.js';
import type { RuntimeServices } from '../runtime.layer.js';
import { SessionLifecycle, SessionLifecycleError } from '../session-lifecycle/index.js';
import { TerminalSessionError, TerminalSessionService } from '../terminal-sessions/index.js';
import { PtyService } from './pty.service.js';
import { PtyResizeError, PtyServiceError, PtyWriteError } from './types.js';

const runWithRuntime =
  (runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>) =>
  <A>(
    effect: Effect.Effect<A, unknown, RuntimeServices>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) =>
    runtime.runPromise(effect, options);

export function registerPtyApi(
  fastify: FastifyInstance,
  runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>,
) {
  const run = runWithRuntime(runtime);

  registerSessionAttachRoute(fastify, run, {
    path: agentSessionPtyWebSocketEndpoint.path,
    paramName: 'agentSessionId',
    sessionKind: 'agent_session',
    resolveProcessId: (sessionId) =>
      Effect.gen(function* () {
        const service = yield* AgentSessionService;
        return yield* service.ensureActivePtyProcess(sessionId);
      }),
  });
  registerSessionAttachRoute(fastify, run, {
    path: terminalSessionPtyWebSocketEndpoint.path,
    paramName: 'terminalSessionId',
    sessionKind: 'terminal_session',
    resolveProcessId: (sessionId) =>
      Effect.gen(function* () {
        const service = yield* TerminalSessionService;
        return yield* service.ensureActivePtyProcess(sessionId);
      }),
  });
}

function registerSessionAttachRoute(
  fastify: FastifyInstance,
  run: ReturnType<typeof runWithRuntime>,
  input: {
    readonly path: string;
    readonly paramName: 'agentSessionId' | 'terminalSessionId';
    readonly sessionKind: 'agent_session' | 'terminal_session';
    readonly resolveProcessId: (
      sessionId: number,
    ) => Effect.Effect<number, unknown, RuntimeServices>;
  },
) {
  fastify.get(
    `${apiBasePath}${input.path}`,
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
      const sessionId = decodeSessionId(request.params, input.paramName);
      const attachToken = decodeAttachToken(request.query);
      if (sessionId === null) {
        send(socket, { type: 'error', code: 'invalid_session_id' });
        socket.close();
        return;
      }

      let closed = false;
      let acceptingClientMessages = false;
      let attachmentId: symbol | null = null;
      let ptyProcessId: number | null = null;
      let unsubscribe = () => {};
      let releaseLifecycleAttachment = () => {};
      const pendingClientMessages: PtyWebSocketInputMessage[] = [];

      socket.once('close', () => {
        closed = true;
        pendingClientMessages.splice(0);
        releaseLifecycleAttachment();
        unsubscribe();
      });

      const sessionKey = { kind: input.sessionKind, sessionId };

      void run(
        Effect.gen(function* () {
          const lifecycle = yield* SessionLifecycle;
          yield* lifecycle.consumeAttachToken({ key: sessionKey, token: attachToken });
          return yield* input.resolveProcessId(sessionId);
        }).pipe(Effect.either),
      )
        .then(async (processResult) => {
          if (Either.isLeft(processResult)) {
            const error = websocketError(processResult.left);
            console.warn(
              '[runtime] PTY websocket session attach failed before process resolution',
              {
                sessionKind: input.sessionKind,
                sessionId,
                errorCode: error.code,
                errorMessage: error.message,
                cause: processResult.left,
              },
            );
            send(socket, { type: 'error', ...error });
            setImmediate(() => socket.close());
            return;
          }
          ptyProcessId = processResult.right;
          const planResult = await run(
            Effect.gen(function* () {
              const pty = yield* PtyService;
              return yield* pty.getAttachmentPlan({ ptySessionId: processResult.right });
            }).pipe(Effect.either),
          );
          if (Either.isLeft(planResult)) {
            const error = websocketError(planResult.left);
            console.warn('[runtime] PTY websocket attachment plan failed', {
              sessionKind: input.sessionKind,
              sessionId,
              ptyProcessId: processResult.right,
              errorCode: error.code,
              errorMessage: error.message,
              cause: planResult.left,
            });
            send(socket, { type: 'error', ...error });
            setImmediate(() => socket.close());
            return;
          }
          const plan = planResult.right;
          send(socket, {
            type: 'session',
            status: plan.session.status,
            exitCode: plan.session.exitCode,
            signal: plan.session.signal,
          });
          if (closed) return;

          const replayResult = await run(
            Effect.gen(function* () {
              const pty = yield* PtyService;
              return yield* pty.replay({
                session: plan.session,
                bytes: plan.replayBytes,
                send: (message) => send(socket, message),
              });
            }).pipe(Effect.either),
          );
          if (Either.isLeft(replayResult)) {
            const error = websocketError(replayResult.left);
            console.warn('[runtime] PTY websocket replay failed', {
              sessionKind: input.sessionKind,
              sessionId,
              ptyProcessId: processResult.right,
              errorCode: error.code,
              errorMessage: error.message,
              cause: replayResult.left,
            });
            send(socket, { type: 'error', ...error });
            setImmediate(() => socket.close());
            return;
          }
          if (!plan.live) {
            acceptingClientMessages = true;
            flushClientMessages();
            return;
          }
          const attachResult = await run(
            Effect.gen(function* () {
              const lifecycle = yield* SessionLifecycle;
              yield* lifecycle.supersedeAttachment(sessionKey);
              const pty = yield* PtyService;
              return yield* pty.attach({
                ptySessionId: processResult.right,
                send: (message) => send(socket, message),
              });
            }).pipe(Effect.either),
          );
          if (Either.isLeft(attachResult)) {
            const error = websocketError(attachResult.left);
            console.warn('[runtime] PTY websocket live attach failed', {
              sessionKind: input.sessionKind,
              sessionId,
              ptyProcessId: processResult.right,
              errorCode: error.code,
              errorMessage: error.message,
              cause: attachResult.left,
            });
            send(socket, { type: 'error', ...error });
            setImmediate(() => socket.close());
            return;
          }
          attachmentId = attachResult.right.attachmentId;
          unsubscribe = attachResult.right.unsubscribe;
          const releaseResult = await run(
            Effect.gen(function* () {
              const lifecycle = yield* SessionLifecycle;
              return yield* lifecycle.registerActiveAttachment({
                key: sessionKey,
                handle: {
                  moved: Effect.gen(function* () {
                    yield* Effect.sync(() => {
                      send(socket, { type: 'error', code: 'session_attachment_moved' });
                      unsubscribe();
                      socket.close();
                    });
                    yield* Effect.promise<void>(
                      () => new Promise((resolve) => setImmediate(resolve)),
                    );
                  }),
                },
              });
            }).pipe(Effect.either),
          );
          if (Either.isRight(releaseResult)) releaseLifecycleAttachment = releaseResult.right;
          if (closed) {
            releaseLifecycleAttachment();
            unsubscribe();
            return;
          }
          acceptingClientMessages = true;
          flushClientMessages();
        })
        .catch((error: unknown) => {
          const socketError = websocketError(error);
          console.error('[runtime] PTY websocket attach crashed', {
            sessionKind: input.sessionKind,
            sessionId,
            errorCode: socketError.code,
            errorMessage: socketError.message,
            cause: error,
          });
          send(socket, { type: 'error', ...socketError });
          socket.close();
        });

      socket.on('message', (raw: Buffer) => {
        if (closed) return;
        const parsed = decodeSocketMessage(raw.toString());
        if (!parsed) {
          send(socket, { type: 'error', code: 'invalid_message' });
          return;
        }
        if (!acceptingClientMessages) {
          pendingClientMessages.push(parsed);
          return;
        }
        runClientMessage(parsed);
      });

      const flushClientMessages = () => {
        for (const message of pendingClientMessages.splice(0)) runClientMessage(message);
      };

      const runClientMessage = (parsed: PtyWebSocketInputMessage) => {
        if (closed || ptyProcessId === null) return;
        const processId = ptyProcessId;
        const effect = Effect.gen(function* () {
          const pty = yield* PtyService;
          if (parsed.type === 'input')
            return yield* pty.write({ ptySessionId: processId, attachmentId, data: parsed.data });
          return yield* pty.resize({
            ptySessionId: processId,
            attachmentId,
            cols: parsed.cols,
            rows: parsed.rows,
          });
        }).pipe(Effect.either);
        void run(effect).then((result) => {
          if (Either.isLeft(result))
            send(socket, { type: 'error', ...websocketError(result.left) });
        });
      };
    },
  );
}

function send(
  socket: { readonly readyState: number; readonly send: (data: string) => void },
  message: PtyWebSocketOutputMessage,
) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

function decodeSessionId(params: unknown, name: 'agentSessionId' | 'terminalSessionId') {
  if (!params || typeof params !== 'object' || !(name in params)) return null;
  const value = (params as Record<string, unknown>)[name];
  const decoded = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof decoded === 'number' && Number.isInteger(decoded) && decoded > 0 ? decoded : null;
}

function decodeAttachToken(query: unknown) {
  if (!query || typeof query !== 'object' || !('attachToken' in query)) return null;
  const value = (query as Record<string, unknown>).attachToken;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function decodeSocketMessage(raw: string) {
  try {
    return Schema.decodeUnknownSync(ptyWebSocketInputMessageSchema)(JSON.parse(raw));
  } catch {
    return null;
  }
}

function websocketError(error: unknown): {
  readonly code: PtyWebSocketErrorCode;
  readonly message?: string;
} {
  if (error instanceof AgentSessionError || error instanceof TerminalSessionError) {
    if (error instanceof AgentSessionError && error.code === 'harness_session_id_missing')
      return { code: 'harness_session_id_missing', message: error.message };
    if (error.code === 'active_process_missing')
      return { code: 'active_process_missing', message: error.message };
    if (error.code === 'active_process_not_running')
      return { code: 'active_process_not_running', message: error.message };
    return { code: 'session_not_found', message: error.message };
  }
  if (error instanceof HarnessAdapterError && error.code === 'unsupported_harness') {
    return { code: 'unsupported_harness', message: error.message };
  }
  if (error instanceof SessionLifecycleError) {
    if (error.code === 'attach_token_expired')
      return { code: 'attach_token_expired', message: error.message };
    if (error.code === 'attach_token_missing')
      return { code: 'attach_token_missing', message: error.message };
    return { code: 'attach_token_invalid', message: error.message };
  }
  if (error instanceof PtyServiceError) return { code: error.code, message: error.message };
  if (error instanceof PtyWriteError || error instanceof PtyResizeError)
    return { code: 'pty_write_failed', message: error.message };
  if (error instanceof DatabaseError)
    return { code: 'pty_state_load_failed', message: `PTY state load failed: ${error.operation}` };
  return { code: 'unknown', message: errorMessage(error) };
}
