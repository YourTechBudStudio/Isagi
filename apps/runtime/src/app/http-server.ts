import type { AddressInfo } from 'node:net';

import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { Cause, Context, Effect, FiberSet, Layer } from 'effect';
import Fastify, { type FastifyInstance } from 'fastify';

import {
  installAllowedOrigins,
  isAllowedRuntimeOrigin,
  sendApiError,
  type RouteRuntime,
} from '../platform/http/index.js';
import { RuntimeConfig } from '../runtime-config/index.js';
import { WorkspaceService } from '../workspace/index.js';
import { ServerLaunch } from './launch.js';
import { AppLayer, type RuntimeServices } from './layer.js';
import {
  describeSource,
  localRuntimeUrl,
  resolveListenSettings,
  RuntimeListenFailed,
} from './listen.js';
import { registerRuntimeRoutes } from './routes.js';
import { startup } from './startup.js';

/** The listening runtime: its URL, and the Fastify instance tests drive with `inject`. */
export class RuntimeServer extends Context.Service<
  RuntimeServer,
  { readonly url: string; readonly fastify: FastifyInstance }
>()('isagi/runtime/app/RuntimeServer') {}

/**
 * The HTTP/WebSocket server as one scoped resource over the runtime's services. Building it starts the runtime;
 * closing its scope shuts it down in this order:
 *
 * 1. request and WebSocket fibers are interrupted (an in-flight request is still answered, an open socket is closed by
 *    its connection's scope);
 * 2. Fastify closes;
 * 3. `MainLayer`'s scope, which owns `AppLayer`, releases the service graph in reverse order along layer dependency
 *    edges only: a service is released before every service its layer depends on (a shared layer stays alive until
 *    its last dependent is released), so the platform goes after the modules that use it. `Layer.mergeAll` releases
 *    its members concurrently, so two modules with no dependency edge between them shut down in no particular order.
 *    A finalizer that needs another module still running must depend on that module's layer.
 *
 * A failure anywhere during construction, including startup after `listen`, closes whatever was already acquired.
 */
export const HttpServerLayer = Layer.effect(
  RuntimeServer,
  Effect.gen(function* () {
    const launch = yield* ServerLaunch;
    const config = yield* RuntimeConfig.use((runtimeConfig) => runtimeConfig.get);
    const { host, port } = resolveListenSettings(launch, config.server);
    yield* Effect.logInfo('Runtime listen settings').pipe(
      Effect.annotateLogs({
        host: host.value,
        hostSource: describeSource(host),
        port: port.value,
        portSource: describeSource(port),
      }),
    );
    // After every service is built, so the command service's activation subscriber hears the restored activation,
    // and before any route can change the active context.
    yield* WorkspaceService.use((workspace) => workspace.publishRestoredActivation);

    const fastify = yield* Effect.acquireRelease(
      Effect.sync(() => Fastify({ logger: false })),
      (server) =>
        tryPromise(() => server.close()).pipe(
          Effect.catch((error) =>
            Effect.logWarning('Runtime HTTP server did not close cleanly', Cause.fail(error)),
          ),
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

    // Before any plugin or route, so every encapsulated context inherits the set.
    installAllowedOrigins(fastify, launch.allowedOrigins);
    const allowedOrigins = fastify.isagiAllowedOrigins ?? new Set<string>();
    configureApiErrorHandlers(fastify);
    yield* tryPromise(() =>
      fastify.register(cors, {
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        origin: (origin, callback) => {
          callback(null, isAllowedRuntimeOrigin(origin, allowedOrigins));
        },
      }),
    );
    yield* tryPromise(() => fastify.register(websocket));
    registerRuntimeRoutes(fastify, runtime);

    yield* tryPromise(() => fastify.listen({ host: host.value, port: port.value })).pipe(
      Effect.mapError((cause) => new RuntimeListenFailed({ host, port, cause })),
      Effect.uninterruptible,
    );
    const url = localRuntimeUrl(fastify.server.address() as AddressInfo);
    yield* startup(url);
    return RuntimeServer.of({ url, fastify });
  }),
);

/**
 * The whole runtime: the server over every module service and the platform, open only in the launch inputs
 * (`launchInputsLayer`). `src/index.ts` launches it.
 *
 * Flag and environment values are validated by `isagi serve` before the runtime module even loads, so a bad
 * `ISAGI_PORT` fails without opening the database or touching the data directory. A bad `config.yaml` `server`
 * section fails while `RuntimeConfig` is built, like any other config section.
 */
export const MainLayer = HttpServerLayer.pipe(Layer.provide(AppLayer));

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
