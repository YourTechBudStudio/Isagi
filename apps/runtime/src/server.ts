import process from 'node:process';

import cors from '@fastify/cors';
import { onError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fastify';
import { Effect, ManagedRuntime } from 'effect';
import Fastify, { type FastifyInstance } from 'fastify';

import { createRouter } from './router.js';
import { RuntimeLayer } from './runtime-layer.js';

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
      yield* tryPromise(() => runtime.runtime());

      const fastify = Fastify({ logger: false });
      startupFastify = fastify;
      fastify.addHook('onClose', async () => {
        await runtime.dispose();
        runtimeDisposed = true;
      });

      const handler = new RPCHandler(createRouter(runtime), {
        interceptors: [
          onError((error) => {
            fastify.log.error(error);
          }),
        ],
      });

      yield* tryPromise(() =>
        fastify.register(cors, {
          origin: (origin, callback) => {
            callback(null, isAllowedRuntimeOrigin(origin));
          },
        }),
      );

      fastify.addContentTypeParser('*', (_request, _payload, done) => {
        done(null, undefined);
      });

      fastify.all('/rpc/*', async (request, reply) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const { matched } = yield* tryPromise(() =>
              handler.handle(request, reply, {
                context: {},
                prefix: '/rpc',
              }),
            );

            if (!matched) {
              reply.status(404).send('Not found');
            }
          }),
        ),
      );

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

function isAllowedRuntimeOrigin(origin: string | undefined) {
  if (!origin || origin === 'null') {
    return true;
  }

  return allowedRuntimeOrigins().has(origin);
}

function allowedRuntimeOrigins() {
  const configured = process.env.ISAGI_ALLOWED_ORIGINS?.split(',') ?? [];
  return new Set(
    ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://[::1]:5173', ...configured]
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function closeFastify(server: FastifyInstance) {
  return tryPromise(() => server.close()).pipe(Effect.ignore);
}

function disposeRuntime<R, E>(runtime: ManagedRuntime.ManagedRuntime<R, E>) {
  return Effect.promise(() => runtime.dispose()).pipe(Effect.ignore);
}

function tryPromise<T>(run: () => PromiseLike<T>) {
  return Effect.tryPromise({
    try: run,
    catch: toError,
  });
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
