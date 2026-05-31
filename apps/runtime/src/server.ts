import cors from '@fastify/cors';
import { onError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fastify';
import { Effect } from 'effect';
import Fastify from 'fastify';

import { router } from './router.js';

const readyPrefix = 'ISAGI_RUNTIME_READY ';

export interface RuntimeServerOptions {
  host?: string;
  port?: number;
}

export function startRuntimeServer(options: RuntimeServerOptions = {}) {
  return Effect.gen(function* () {
    const fastify = Fastify({ logger: false });
    const handler = new RPCHandler(router, {
      interceptors: [
        onError((error) => {
          fastify.log.error(error);
        }),
      ],
    });

    yield* tryPromise(() => fastify.register(cors, { origin: true }));

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
    );

    return { server: fastify, url };
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

function tryPromise<T>(run: () => PromiseLike<T>) {
  return Effect.tryPromise({
    try: run,
    catch: toError,
  });
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
