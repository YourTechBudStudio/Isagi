import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { Context, Effect, FiberSet, Layer } from 'effect';
import Fastify, { type FastifyInstance } from 'fastify';

import { isAllowedRuntimeOrigin, sendApiError, type RouteRuntime } from '../platform/http/index.js';
import { WorkspaceService } from '../workspace/index.js';
import { AppLayer, type RuntimeServices } from './layer.js';
import { RuntimeSettings } from './logger.js';
import { registerRuntimeRoutes } from './routes.js';
import { startup } from './startup.js';

/** The listening runtime: its URL, and the Fastify instance tests drive with `inject`. */
export class RuntimeServer extends Context.Service<
  RuntimeServer,
  { readonly url: string; readonly fastify: FastifyInstance }
>()('isagi/runtime/app/RuntimeServer') {}

/**
 * The HTTP/WebSocket server as one scoped resource over the runtime's services. Building it starts the runtime;
 * closing its scope shuts it down in reverse order of acquisition:
 *
 * 1. request and WebSocket fibers are interrupted (an in-flight request is still answered, an open socket is closed by
 *    its connection's scope);
 * 2. Fastify closes;
 * 3. the module services and the platform are released (by `MainLayer`'s scope, which owns `AppLayer`).
 *
 * A failure anywhere during construction, including startup after `listen`, closes whatever was already acquired.
 */
export const HttpServerLayer = Layer.effect(
  RuntimeServer,
  Effect.gen(function* () {
    const settings = yield* RuntimeSettings;
    // After every service is built, so the command service's activation subscriber hears the restored activation,
    // and before any route can change the active context.
    yield* WorkspaceService.use((workspace) => workspace.publishRestoredActivation);

    const fastify = yield* Effect.acquireRelease(
      Effect.sync(() => Fastify({ logger: false })),
      (server) =>
        tryPromise(() => server.close()).pipe(
          Effect.catch((error) => Effect.logWarning('runtime.http_server_close_failed', error)),
        ),
    );
    // Acquired after Fastify, so released before it: every request and socket fiber is interrupted (and answered)
    // before Fastify waits for its connections.
    const requests = yield* FiberSet.make<unknown, unknown>();
    const runPromise = yield* FiberSet.runtimePromise(requests)<RuntimeServices>();
    const runFork = yield* FiberSet.runtime(requests)<RuntimeServices>();
    const runtime: RouteRuntime<RuntimeServices> = {
      runPromise: (effect, options) => runPromise(effect, options),
      runFork: (effect) => void runFork(effect),
    };

    configureApiErrorHandlers(fastify);
    yield* tryPromise(() =>
      fastify.register(cors, {
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        origin: (origin, callback) => {
          callback(null, isAllowedRuntimeOrigin(origin));
        },
      }),
    );
    yield* tryPromise(() => fastify.register(websocket));
    registerRuntimeRoutes(fastify, runtime);

    const url = yield* tryPromise(() =>
      fastify.listen({ host: settings.host, port: settings.port }),
    ).pipe(Effect.uninterruptible);
    yield* startup(url);
    return RuntimeServer.of({ url, fastify });
  }),
);

/**
 * The whole runtime: the server over every module service and the platform. `src/index.ts` launches it.
 *
 * The settings are checked before anything is built, so a bad `PORT` fails startup without opening the database or
 * touching the data directory, as it always has; `HttpServerLayer` reads the same values again when it listens.
 */
export const MainLayer = Layer.unwrap(
  Effect.as(RuntimeSettings, HttpServerLayer.pipe(Layer.provide(AppLayer))),
);

/**
 * Fastify's own failures (a plugin that fails to register, `listen` failing with `EADDRINUSE`) keep their error, so
 * the startup failure line shows what the host saw.
 */
function tryPromise<A>(run: () => PromiseLike<A>) {
  return Effect.tryPromise({
    try: () => Promise.resolve().then(run),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
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
