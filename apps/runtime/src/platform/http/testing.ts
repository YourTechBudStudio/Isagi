import cors from '@fastify/cors';
import { Effect, Exit, FiberSet, Layer, ManagedRuntime, Scope } from 'effect';
import Fastify, { type FastifyInstance } from 'fastify';

import { installAllowedOrigins, isAllowedRuntimeOrigin } from './origin.js';
import type { RouteRuntime } from './route-runtime.js';

/** A `RouteRuntime` over a test's `ManagedRuntime`. Production routes get theirs from the server's request fibers. */
export function routeRuntimeOf<R, E>(
  runtime: ManagedRuntime.ManagedRuntime<R, E>,
): RouteRuntime<R> {
  return {
    runPromise: (effect, options) => runtime.runPromise(effect, options),
    runFork: (effect) => void runtime.runFork(effect),
  };
}

/** A `RouteRuntime` for routes that need no service, running each request with the default runtime. */
export const serviceFreeRouteRuntime: RouteRuntime<never> = {
  runPromise: (effect, options) => Effect.runPromise(effect, options),
  runFork: (effect) => void Effect.runFork(effect),
};

/**
 * Runs `run` against a Fastify instance whose routes `register` added over `layer`'s services, then closes Fastify and
 * disposes the services. Requests go through `fastify.inject`/`injectWS`, so nothing listens on a port.
 *
 * `register` may be async, for routes that need a plugin (such as `@fastify/websocket`) registered first.
 */
export async function withApiServer<R, E, A>(
  layer: Layer.Layer<R, E>,
  register: (fastify: FastifyInstance, runtime: RouteRuntime<R>) => void | Promise<void>,
  run: (fastify: FastifyInstance) => Promise<A>,
  options: TestServerOptions = {},
): Promise<A> {
  const runtime = ManagedRuntime.make(layer);
  try {
    const fastify = Fastify({ logger: false });
    installAllowedOrigins(fastify, options.allowedOrigins ?? []);
    // Nested rather than sequential in one `finally`, so a rejected `fastify.close()` cannot leak the services.
    try {
      await register(fastify, routeRuntimeOf(runtime));
      await fastify.ready();
      return await run(fastify);
    } finally {
      await fastify.close();
    }
  } finally {
    await runtime.dispose();
  }
}

export interface TestServerOptions {
  /** The browser origins the server accepts, as `serve --allowed-origins` installs them. Default none. */
  readonly allowedOrigins?: readonly string[];
}

export interface ListeningServer {
  /** `http://127.0.0.1:<port>` plus `apiBasePath`-relative paths are the caller's to add. */
  readonly origin: string;
  /** Interrupts every route fiber, as server shutdown does, without closing the listener. */
  readonly interruptRoutes: () => Promise<void>;
}

/**
 * Runs `run` against a real listening Fastify instance on port 0, with the server's CORS policy and
 * routes run on a `FiberSet` over `layer`'s services the way `http-server.ts` runs them. For
 * streaming routes, whose disconnect and shutdown behavior `inject` cannot exercise. Everything is
 * torn down afterwards.
 */
export async function withListeningServer<R, A>(
  layer: Layer.Layer<R>,
  register: (fastify: FastifyInstance, runtime: RouteRuntime<R>) => void,
  run: (server: ListeningServer) => Promise<A>,
  options: TestServerOptions = {},
): Promise<A> {
  const scope = Scope.makeUnsafe();
  const fibers = await Effect.runPromise(
    Effect.gen(function* () {
      const services = yield* Layer.buildWithScope(layer, scope);
      const set = yield* FiberSet.make<unknown, unknown>();
      return yield* Effect.provideContext(
        Effect.all({
          runPromise: FiberSet.runtimePromise(set)<R>(),
          runFork: FiberSet.runtime(set)<R>(),
        }),
        services,
      );
    }).pipe(Scope.provide(scope)),
  );
  const runtime: RouteRuntime<R> = {
    runPromise: (effect, runOptions) => fibers.runPromise(effect, runOptions),
    runFork: (effect) => void fibers.runFork(effect),
  };
  const fastify = Fastify({ logger: false });
  installAllowedOrigins(fastify, options.allowedOrigins ?? []);
  const allowedOrigins = fastify.isagiAllowedOrigins ?? new Set<string>();
  try {
    await fastify.register(cors, {
      origin: (origin, callback) => callback(null, isAllowedRuntimeOrigin(origin, allowedOrigins)),
    });
    register(fastify, runtime);
    const address = await fastify.listen({ host: '127.0.0.1', port: 0 });
    return await run({
      origin: address,
      interruptRoutes: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    });
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await fastify.close();
  }
}
