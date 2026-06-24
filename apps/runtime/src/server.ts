import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { Effect, Exit, ManagedRuntime } from 'effect';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerCommandsApi } from './commands/index.js';
import { registerHealthApi } from './health/api.js';
import { sendApiError } from './lib/api/index.js';
import { isAllowedRuntimeOrigin } from './lib/security/origin.js';
import { registerPathsApi } from './paths/api.js';
import { registerPtyApi } from './pty-processes/index.js';
import { registerRuntimeEventsApi } from './runtime-events/index.js';
import { RuntimeLayer } from './runtime.layer.js';
import { registerSurfacesApi } from './surfaces/index.js';
import { registerWorkflowDevApi } from './workflows/index.js';
import { registerWorkspaceApi } from './workspace/api.js';

const readyPrefix = 'ISAGI_RUNTIME_READY ';

export interface RuntimeServerOptions {
  host?: string;
  port?: number;
}

export function startRuntimeServer(options: RuntimeServerOptions = {}) {
  return Effect.gen(function* () {
    const runtime = ManagedRuntime.make(RuntimeLayer);
    let startupOwnsResources = true;
    let startupFastify: FastifyInstance | undefined;
    let runtimeDisposed = false;

    return yield* Effect.gen(function* () {
      yield* initializeRuntime(runtime);

      const fastify = Fastify({ logger: false });
      startupFastify = fastify;
      fastify.setNotFoundHandler((request, reply) =>
        sendApiError(reply, {
          code: 'api_route_not_found',
          status: 404,
          message: `Route not found: ${request.method} ${request.url}`,
          requestId: String(request.id),
          data: { method: request.method, url: request.url },
        }),
      );
      fastify.setErrorHandler((error, request, reply) => {
        const status = errorStatusCode(error);
        return sendApiError(reply, {
          code: status === 400 ? 'api_request_parsing_failed' : 'api_unhandled_error',
          status,
          message: errorMessage(error),
          requestId: String(request.id),
          data: { method: request.method, url: request.url },
        });
      });
      fastify.addHook('onClose', async () => {
        await runtime.dispose();
        runtimeDisposed = true;
      });

      yield* tryPromise(() =>
        fastify.register(cors, {
          methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
          origin: (origin, callback) => {
            callback(null, isAllowedRuntimeOrigin(origin));
          },
        }),
      );

      yield* tryPromise(() => fastify.register(websocket));

      registerHealthApi(fastify);
      registerCommandsApi(fastify, runtime);
      registerWorkspaceApi(fastify, runtime);
      registerSurfacesApi(fastify, runtime);
      registerPtyApi(fastify, runtime);
      registerRuntimeEventsApi(fastify, runtime);
      registerPathsApi(fastify);
      // Workflow dev triggers start in-process, fully-trusted user-authored callbacks
      // (see docs/workflow-engine.md trust model). They are deliberately live in all
      // builds: the runtime's boundary is loopback binding + the established
      // unauthenticated trust posture shared by every route group above, not route
      // gating. Revisit if the runtime ever serves untrusted callers.
      registerWorkflowDevApi(fastify, runtime);

      const url = yield* tryPromise(() =>
        fastify.listen({
          host: options.host ?? '127.0.0.1',
          port: options.port ?? 0,
        }),
      ).pipe(Effect.uninterruptible);

      startupOwnsResources = false;
      return { server: fastify, url };
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          if (!startupOwnsResources) {
            return Effect.void;
          }

          return Effect.gen(function* () {
            if (startupFastify) {
              yield* closeFastify(startupFastify);
            }
            if (!runtimeDisposed) {
              yield* disposeRuntime(runtime);
            }
          });
        }),
      ),
    );
  });
}

export function formatReadyLine(url: string) {
  return `${readyPrefix}${JSON.stringify({ url })}`;
}

export function parsePort(value: string | undefined) {
  if (!value) {
    return Effect.succeed(0);
  }

  const port = Number.parseInt(value, 10);

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    return Effect.fail(new Error(`Invalid PORT value: ${value}`));
  }

  return Effect.succeed(port);
}

function closeFastify(server: FastifyInstance) {
  return tryPromise(() => server.close()).pipe(Effect.ignore);
}

function disposeRuntime<R, E>(runtime: ManagedRuntime.ManagedRuntime<R, E>) {
  return Effect.promise(() => runtime.dispose()).pipe(Effect.ignore);
}

function initializeRuntime<R, E>(runtime: ManagedRuntime.ManagedRuntime<R, E>) {
  return Effect.promise(() => runtime.runPromiseExit(Effect.void)).pipe(
    Effect.flatMap((exit) => (Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.void)),
  );
}

function tryPromise<T>(run: () => T | PromiseLike<T>) {
  return Effect.tryPromise({
    try: () => Promise.resolve().then(run),
    catch: toError,
  });
}

function errorStatusCode(error: unknown) {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 599) {
      return statusCode;
    }
  }
  return 500;
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error) {
    return error;
  }
  return 'Unhandled runtime API error';
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
