import { Effect, Either, Schema, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import {
  apiBasePath,
  apiEndpoints,
  ptySessionWebSocketEndpoint,
  ptyWebSocketInputMessageSchema,
  type ApiError,
  type PtyWebSocketErrorCode,
  type PtyWebSocketOutputMessage,
} from '@isagi/contracts';

import { registerApiEndpoint, type ApiRouteContext, errorMessage } from '../lib/api/index.js';
import { isAllowedRuntimeOrigin } from '../lib/security/origin.js';
import { DatabaseError } from '../persistence/index.js';
import type { RuntimeServices } from '../runtime.layer.js';
import { PtyService, PtyServiceError } from './pty.service.js';
import { PtyResizeError, PtyWriteError } from './types.js';

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

  registerApiEndpoint(fastify, apiEndpoints.surfaces.launchAgentSession, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const pty = yield* PtyService;
        return yield* pty.launch({
          worktreeId: params.worktreeId,
          purpose: 'agent',
          harness: input.harness,
        });
      }),
    mapError: (error, context) => toSessionLaunchApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.surfaces.launchTerminalSession, {
    handle: (_input, _context, params) =>
      Effect.gen(function* () {
        const pty = yield* PtyService;
        return yield* pty.launch({
          worktreeId: params.worktreeId,
          purpose: 'terminal',
          harness: null,
        });
      }),
    mapError: (error, context) => toSessionLaunchApiError(error, context),
    run,
  });

  fastify.get(
    `${apiBasePath}${ptySessionWebSocketEndpoint.path}`,
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
      const ptySessionId = decodePtySessionId(request.params);
      if (ptySessionId === null) {
        socket.send(
          JSON.stringify({
            type: 'error',
            code: 'invalid_session_id',
          } satisfies PtyWebSocketOutputMessage),
        );
        socket.close();
        return;
      }

      const send = (message: PtyWebSocketOutputMessage) => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(message));
        }
      };

      let replaying = true;
      let closed = false;
      let unsubscribe = () => {};
      const pending: PtyWebSocketOutputMessage[] = [];
      socket.once('close', () => {
        closed = true;
        unsubscribe();
      });
      const attachmentPromise = run(
        Effect.gen(function* () {
          const pty = yield* PtyService;
          return yield* pty.attach({
            ptySessionId,
            send: (message) => {
              if (replaying) {
                pending.push(message);
              } else {
                send(message);
              }
            },
          });
        }).pipe(Effect.either),
      );

      void attachmentPromise
        .then(async (attachmentResult) => {
          if (Either.isLeft(attachmentResult)) {
            await new Promise((resolve) => setImmediate(resolve));
            send({ type: 'error', ...websocketError(attachmentResult.left) });
            setImmediate(() => socket.close());
            return;
          }

          const attachment = attachmentResult.right;
          await new Promise((resolve) => setImmediate(resolve));
          send({
            type: 'session',
            status: attachment.session.status,
            exitCode: attachment.session.exitCode,
            signal: attachment.session.signal,
          });
          unsubscribe = attachment.unsubscribe;
          if (closed) {
            unsubscribe();
            return;
          }
          const replayResult = await run(
            Effect.gen(function* () {
              const pty = yield* PtyService;
              return yield* pty.replay({
                session: attachment.session,
                bytes: attachment.replayOffset,
                send,
              });
            }).pipe(Effect.either),
          );
          if (Either.isLeft(replayResult)) {
            console.error(
              `[runtime] PTY websocket replay failed ptySessionId=${ptySessionId}`,
              replayResult.left,
            );
            send({ type: 'error', ...websocketError(replayResult.left) });
            setImmediate(() => socket.close());
            return;
          }
          replaying = false;
          if (closed) {
            unsubscribe();
            return;
          }
          for (const message of pending.splice(0)) {
            send(message);
          }
        })
        .catch((error: unknown) => {
          send({ type: 'error', ...websocketError(error) });
          socket.close();
        });

      socket.on('message', (raw: Buffer) => {
        if (closed) {
          return;
        }
        const parsed = decodeSocketMessage(raw.toString());
        if (!parsed) {
          send({ type: 'error', code: 'invalid_message' });
          return;
        }

        const effect = Effect.gen(function* () {
          const pty = yield* PtyService;
          if (parsed.type === 'input') {
            return yield* pty.write({ ptySessionId, data: parsed.data });
          }
          return yield* pty.resize({ ptySessionId, cols: parsed.cols, rows: parsed.rows });
        });

        void run(effect.pipe(Effect.either)).then(
          (result) => {
            if (Either.isLeft(result)) {
              send({ type: 'error', ...websocketError(result.left) });
            }
          },
          (error: unknown) => {
            console.error(
              `[runtime] PTY websocket input failed ptySessionId=${ptySessionId}`,
              error,
            );
            send({ type: 'error', ...websocketError(error) });
          },
        );
      });
    },
  );
}

function decodePtySessionId(params: unknown) {
  if (!params || typeof params !== 'object' || !('ptySessionId' in params)) {
    return null;
  }
  const value = (params as { readonly ptySessionId?: unknown }).ptySessionId;
  const decoded = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof decoded === 'number' && Number.isInteger(decoded) && decoded > 0 ? decoded : null;
}

function decodeSocketMessage(raw: string) {
  try {
    return Schema.decodeUnknownSync(ptyWebSocketInputMessageSchema)(JSON.parse(raw));
  } catch {
    return null;
  }
}

// Maps a runtime failure to a stable error code plus an optional diagnostic detail.
// The user-facing wording lives in the web copy layer, keyed off `code`; the
// `message` here is for logs and bug reports only and is never rendered as-is.
function websocketError(error: unknown): {
  readonly code: PtyWebSocketErrorCode;
  readonly message?: string;
} {
  if (error instanceof PtyServiceError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof PtyWriteError || error instanceof PtyResizeError) {
    return { code: 'pty_write_failed', message: error.message };
  }
  if (error instanceof DatabaseError) {
    return { code: 'pty_state_load_failed', message: `PTY state load failed: ${error.operation}` };
  }
  return { code: 'unknown', message: errorMessage(error) };
}

function toSessionLaunchApiError(error: unknown, context: ApiRouteContext): ApiError {
  if (error instanceof PtyServiceError && error.code === 'worktree_not_found') {
    return {
      code: 'session_launch_rejected',
      status: 400,
      message: error.message,
      requestId: context.requestId,
      data: {
        reason: 'worktree_not_found',
        ...(error.worktreeId ? { worktreeId: error.worktreeId } : {}),
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

  console.error(`[runtime] Unhandled PTY API handler error during ${context.endpointId}`, error);

  return {
    code: 'api_unhandled_error',
    status: 500,
    message: errorMessage(error),
    requestId: context.requestId,
    data: { endpointId: context.endpointId },
  };
}
