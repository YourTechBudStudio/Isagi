import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { Effect, Exit, ManagedRuntime } from 'effect';
import Fastify, { type FastifyInstance } from 'fastify';

import { CliAccess } from '../cli-access/index.js';
import { registerCommandsApi } from '../commands/index.js';
import { registerEditorApi, EditorProvisioning } from '../editor/index.js';
import {
  registerAgentSessionsApi,
  registerPtyApi,
  registerSurfacesApi,
  SurfaceService,
} from '../environment/index.js';
import { registerControlPlaneApi, HarnessControlPlane } from '../harnesses/index.js';
import { sendApiError, isAllowedRuntimeOrigin } from '../platform/http/index.js';
import { registerClientSettingsApi } from '../runtime-config/index.js';
import { registerRuntimeEventsApi } from '../runtime-events/index.js';
import { registerWorkflowApi } from '../workflows/index.js';
import { registerWorkspaceApi, registerPathsApi } from '../workspace/index.js';
import { registerHealthApi } from './health-api.js';
import { RuntimeLayer } from './layer.js';

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
      configureApiErrorHandlers(fastify);

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
      registerAgentSessionsApi(fastify, runtime);
      registerClientSettingsApi(fastify, runtime);
      registerControlPlaneApi(fastify, runtime);
      registerCommandsApi(fastify, runtime);
      registerWorkspaceApi(fastify, runtime);
      registerSurfacesApi(fastify, runtime);
      registerPtyApi(fastify, runtime);
      registerRuntimeEventsApi(fastify, runtime);
      registerEditorApi(fastify, runtime);
      registerPathsApi(fastify);
      registerWorkflowApi(fastify, runtime);

      const url = yield* tryPromise(() =>
        fastify.listen({
          host: options.host ?? '127.0.0.1',
          port: options.port ?? 0,
        }),
      ).pipe(Effect.uninterruptible);
      // Before anything can launch a PTY — the control plane and restored sessions below — so every
      // terminal and agent session gets `ISAGI_RUNTIME_URL`.
      yield* runInRuntime(
        runtime,
        Effect.flatMap(CliAccess, (cliAccess) => cliAccess.publishRuntimeUrl(url)),
      );
      yield* runInRuntime(
        runtime,
        Effect.flatMap(HarnessControlPlane, (controlPlane) => controlPlane.start),
      );
      // Forks into the layer scope and returns immediately. The host treats a
      // 15-second readiness deadline as fatal and the pinned Code Server
      // artifacts are 200–235 MB, so a first-run download must never sit between
      // this point and the ready line.
      yield* runInRuntime(
        runtime,
        Effect.flatMap(EditorProvisioning, (provisioning) => provisioning.start),
      );
      yield* runInRuntime(
        runtime,
        Effect.flatMap(SurfaceService, (surfaces) => surfaces.restorePaneBoundSessions),
      );

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

function configureApiErrorHandlers(fastify: FastifyInstance) {
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

function runInRuntime<R, E, A, E2>(
  runtime: ManagedRuntime.ManagedRuntime<R, E>,
  effect: Effect.Effect<A, E2, R>,
) {
  return Effect.promise(() => runtime.runPromise(effect));
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
