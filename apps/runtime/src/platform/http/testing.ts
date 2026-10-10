import { Effect, ManagedRuntime, type Layer } from 'effect';
import Fastify, { type FastifyInstance } from 'fastify';

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
): Promise<A> {
  const runtime = ManagedRuntime.make(layer);
  try {
    const fastify = Fastify({ logger: false });
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
