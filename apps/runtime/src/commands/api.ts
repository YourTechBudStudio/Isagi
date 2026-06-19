import { Effect, Either, Schema, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import {
  apiBasePath,
  apiEndpoints,
  commandLogStreamWebSocketEndpoint,
  ptyWebSocketInputMessageSchema,
  type ApiError,
  type CommandLogStreamErrorCode,
  type CommandLogStreamOutputMessage,
} from '@isagi/contracts';

import { registerApiEndpoint, type ApiRouteContext, errorMessage } from '../lib/api/index.js';
import { isAllowedRuntimeOrigin } from '../lib/security/origin.js';
import { DatabaseError } from '../persistence/index.js';
import { PtyService, PtyServiceError } from '../pty-processes/index.js';
import type { RuntimeServices } from '../runtime.layer.js';
import { CommandError, CommandService } from './commands.service.js';

const runWithRuntime =
  (runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>) =>
  <A>(
    effect: Effect.Effect<A, unknown, RuntimeServices>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) =>
    runtime.runPromise(effect, options);

export function registerCommandsApi(
  fastify: FastifyInstance,
  runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>,
) {
  const run = runWithRuntime(runtime);

  registerApiEndpoint(fastify, apiEndpoints.commands.listForWorktree, {
    handle: (_input, _context, params) =>
      Effect.gen(function* () {
        const commands = yield* CommandService;
        return yield* commands.listForWorktree(params.worktreeId);
      }),
    mapError: (error, context) => toCommandApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.commands.logMetadata, {
    handle: (_input, _context, params, query) =>
      Effect.gen(function* () {
        const commands = yield* CommandService;
        return yield* commands.readLogMetadata({
          worktreeId: params.worktreeId,
          commandName: query.commandName,
        });
      }),
    mapError: (error, context) => toCommandApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.commands.run, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const commands = yield* CommandService;
        return yield* commands.run({
          worktreeId: params.worktreeId,
          commandName: input.commandName,
        });
      }),
    mapError: (error, context) => toCommandApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.commands.stop, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const commands = yield* CommandService;
        return yield* commands.stop({
          worktreeId: params.worktreeId,
          commandName: input.commandName,
        });
      }),
    mapError: (error, context) => toCommandApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.commands.restart, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const commands = yield* CommandService;
        return yield* commands.restart({
          worktreeId: params.worktreeId,
          commandName: input.commandName,
        });
      }),
    mapError: (error, context) => toCommandApiError(error, context),
    run,
  });

  registerCommandLogStreamRoute(fastify, run);
}

function registerCommandLogStreamRoute(
  fastify: FastifyInstance,
  run: ReturnType<typeof runWithRuntime>,
) {
  fastify.get(
    `${apiBasePath}${commandLogStreamWebSocketEndpoint.path}`,
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
      const worktreeId = decodeWorktreeId(request.params);
      const commandName = decodeCommandName(request.query);
      if (worktreeId === null || commandName === null) {
        sendSocketError(socket, { code: 'command_not_found' });
        socket.close();
        return;
      }

      let closed = false;
      let replaying = false;
      let unsubscribe = () => {};
      const bufferedLiveMessages: CommandLogStreamOutputMessage[] = [];

      socket.once('close', () => {
        closed = true;
        bufferedLiveMessages.splice(0);
        unsubscribe();
      });

      const send = (message: CommandLogStreamOutputMessage) => sendSocketMessage(socket, message);
      const sendLive = (message: CommandLogStreamOutputMessage) => {
        if (closed) return;
        if (replaying) {
          bufferedLiveMessages.push(message);
          return;
        }
        send(message);
        if (message.type === 'exit') setImmediate(() => socket.close());
      };
      const flushLiveBuffer = () => {
        for (const message of bufferedLiveMessages.splice(0)) {
          if (closed) return;
          send(message);
          if (message.type === 'exit') {
            setImmediate(() => socket.close());
            return;
          }
        }
      };

      void run(
        Effect.gen(function* () {
          const commands = yield* CommandService;
          const pty = yield* PtyService;
          const metadata = yield* commands.readLogMetadata({ worktreeId, commandName });
          const ptyProcessId = metadata.latestRun?.ptyProcessId ?? null;
          const plan = ptyProcessId ? yield* pty.getAttachmentPlan({ ptyProcessId }) : null;
          const live = ptyProcessId
            ? yield* pty.canObserveOutput({ ptyProcessId }).pipe(Effect.orElseSucceed(() => false))
            : false;
          return { metadata, plan, live };
        }).pipe(Effect.either),
      )
        .then(async (result) => {
          if (closed) return;
          if (Either.isLeft(result)) {
            const error = commandLogStreamError(result.left);
            console.warn('[runtime] Command log stream failed before replay', {
              worktreeId,
              commandName,
              errorCode: error.code,
              errorMessage: error.message,
              cause: result.left,
            });
            sendSocketError(socket, error);
            setImmediate(() => socket.close());
            return;
          }

          const { metadata, plan, live } = result.right;
          let streamLive = live;
          send({
            type: 'command_log_state',
            worktreeId: metadata.worktreeId,
            commandName: metadata.commandName,
            status: metadata.status,
            latestRun: metadata.latestRun,
            live,
          });

          if (!metadata.latestRun || !metadata.latestRun.ptyProcessId || !plan) {
            setImmediate(() => socket.close());
            return;
          }
          const streamPtyProcessId = metadata.latestRun.ptyProcessId;
          let replayBytes = plan.replayBytes;
          let replaySession = plan.session;

          if (streamLive) {
            const observeResult = await run(
              Effect.gen(function* () {
                const pty = yield* PtyService;
                return yield* pty.observeOutput({
                  ptyProcessId: streamPtyProcessId,
                  send: (message) => {
                    if (message.type === 'output' || message.type === 'exit') sendLive(message);
                  },
                });
              }).pipe(Effect.either),
            );
            if (Either.isLeft(observeResult)) {
              if (shouldReplayAfterObserveFailure(observeResult.left)) {
                const fallbackPlan = await run(
                  Effect.gen(function* () {
                    const pty = yield* PtyService;
                    return yield* pty.getAttachmentPlan({ ptyProcessId: streamPtyProcessId });
                  }).pipe(Effect.either),
                );
                if (Either.isRight(fallbackPlan)) {
                  replayBytes = fallbackPlan.right.replayBytes;
                  replaySession = fallbackPlan.right.session;
                  streamLive = false;
                  send({
                    type: 'command_log_state',
                    worktreeId: metadata.worktreeId,
                    commandName: metadata.commandName,
                    status: metadata.status,
                    latestRun: metadata.latestRun,
                    live: false,
                  });
                } else {
                  const error = commandLogStreamError(fallbackPlan.left);
                  console.warn('[runtime] Command log stream fallback replay failed', {
                    worktreeId,
                    commandName,
                    ptyProcessId: streamPtyProcessId,
                    errorCode: error.code,
                    errorMessage: error.message,
                    cause: fallbackPlan.left,
                  });
                  sendSocketError(socket, error);
                  setImmediate(() => socket.close());
                  return;
                }
              } else {
                const error = commandLogStreamError(observeResult.left);
                console.warn('[runtime] Command log stream observe failed', {
                  worktreeId,
                  commandName,
                  ptyProcessId: streamPtyProcessId,
                  errorCode: error.code,
                  errorMessage: error.message,
                  cause: observeResult.left,
                });
                sendSocketError(socket, error);
                setImmediate(() => socket.close());
                return;
              }
            } else {
              replayBytes = observeResult.right.replayBytes;
              replaySession = observeResult.right.session;
              unsubscribe = observeResult.right.unsubscribe;
            }
          }

          replaying = true;
          const replayResult = await run(
            Effect.gen(function* () {
              const pty = yield* PtyService;
              return yield* pty.replay({
                session: replaySession,
                bytes: replayBytes,
                send: (message) => {
                  if (
                    message.type === 'replay_start' ||
                    message.type === 'output' ||
                    message.type === 'replay_end'
                  ) {
                    send(message);
                  }
                },
              });
            }).pipe(Effect.either),
          );
          replaying = false;

          if (Either.isLeft(replayResult)) {
            const error = commandLogStreamError(replayResult.left);
            console.warn('[runtime] Command log stream replay failed', {
              worktreeId,
              commandName,
              ptyProcessId: streamPtyProcessId,
              errorCode: error.code,
              errorMessage: error.message,
              cause: replayResult.left,
            });
            sendSocketError(socket, error);
            setImmediate(() => socket.close());
            return;
          }

          flushLiveBuffer();
          if (!streamLive) setImmediate(() => socket.close());
        })
        .catch((error: unknown) => {
          const socketError = commandLogStreamError(error);
          console.error('[runtime] Command log stream crashed', {
            worktreeId,
            commandName,
            errorCode: socketError.code,
            errorMessage: socketError.message,
            cause: error,
          });
          sendSocketError(socket, socketError);
          socket.close();
        });

      socket.on('message', (raw: Buffer) => {
        if (closed) return;
        const parsed = decodeClientMessage(raw.toString());
        if (!parsed) {
          sendSocketError(socket, { code: 'invalid_message' });
          socket.close();
          return;
        }
        sendSocketError(socket, { code: 'read_only_stream' });
        socket.close();
      });
    },
  );
}

function toCommandApiError(error: unknown, context: ApiRouteContext): ApiError {
  if (error instanceof CommandError) {
    // `command_action_failed` is an operational failure (a PTY termination that
    // did not go through), not a request the caller can fix — surface it as a
    // degraded-runtime 500 so it reads differently from validation/not-found.
    const status = error.code === 'command_action_failed' ? 500 : 400;
    return {
      code: 'worktree_commands_rejected',
      status,
      message: error.message,
      requestId: context.requestId,
      data: {
        reason: error.code,
        ...(error.worktreeId ? { worktreeId: error.worktreeId } : {}),
        ...(error.commandName ? { commandName: error.commandName } : {}),
      },
    };
  }

  if (error instanceof DatabaseError) {
    return {
      code: 'runtime_database_failed',
      status: 500,
      message: `Database operation failed: ${error.operation}`,
      requestId: context.requestId,
      data: { operation: error.operation },
    };
  }

  console.error(
    `[runtime] Unhandled command API handler error during ${context.endpointId}`,
    error,
  );

  return {
    code: 'api_unhandled_error',
    status: 500,
    message: errorMessage(error),
    requestId: context.requestId,
    data: { endpointId: context.endpointId },
  };
}

function decodeWorktreeId(params: unknown) {
  if (!params || typeof params !== 'object' || !('worktreeId' in params)) return null;
  const value = (params as Record<string, unknown>).worktreeId;
  const decoded = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof decoded === 'number' && Number.isInteger(decoded) && decoded > 0 ? decoded : null;
}

function decodeCommandName(query: unknown) {
  if (!query || typeof query !== 'object' || !('commandName' in query)) return null;
  const value = (query as Record<string, unknown>).commandName;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function decodeClientMessage(raw: string) {
  try {
    return Schema.decodeUnknownSync(ptyWebSocketInputMessageSchema)(JSON.parse(raw));
  } catch {
    return null;
  }
}

function sendSocketMessage(
  socket: { readonly readyState: number; readonly send: (data: string) => void },
  message: CommandLogStreamOutputMessage,
) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

function sendSocketError(
  socket: { readonly readyState: number; readonly send: (data: string) => void },
  error: { readonly code: CommandLogStreamErrorCode; readonly message?: string },
) {
  sendSocketMessage(socket, { type: 'error', ...error });
}

function commandLogStreamError(error: unknown): {
  readonly code: CommandLogStreamErrorCode;
  readonly message?: string;
} {
  if (error instanceof CommandError) {
    if (
      error.code === 'worktree_not_found' ||
      error.code === 'command_config_invalid' ||
      error.code === 'command_not_found'
    ) {
      return { code: error.code, message: error.message };
    }
    return { code: 'unknown', message: error.message };
  }
  if (error instanceof PtyServiceError) {
    switch (error.code) {
      case 'backend_unavailable':
      case 'backend_session_missing':
      case 'backend_attach_failed':
      case 'log_read_failed':
        return { code: error.code, message: error.message };
      case 'session_not_found':
      case 'session_not_running':
      case 'active_process_missing':
      case 'active_process_not_running':
      case 'session_already_attached':
        return { code: 'backend_attach_failed', message: error.message };
    }
  }
  if (error instanceof DatabaseError)
    return {
      code: 'pty_state_load_failed',
      message: `PTY state load failed: ${error.operation}`,
    };
  return { code: 'unknown', message: errorMessage(error) };
}

function shouldReplayAfterObserveFailure(error: unknown) {
  return (
    error instanceof PtyServiceError &&
    (error.code === 'session_not_running' || error.code === 'active_process_not_running')
  );
}
