import cors from '@fastify/cors';
import { onError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fastify';
import Fastify from 'fastify';

import { router } from './router.js';

const readyPrefix = 'ISAGI_RUNTIME_READY ';

export interface RuntimeServerOptions {
  host?: string;
  port?: number;
}

export async function startRuntimeServer(options: RuntimeServerOptions = {}) {
  const fastify = Fastify({ logger: false });
  const handler = new RPCHandler(router, {
    interceptors: [
      onError((error) => {
        fastify.log.error(error);
      }),
    ],
  });

  await fastify.register(cors, { origin: true });

  fastify.addContentTypeParser('*', (_request, _payload, done) => {
    done(null, undefined);
  });

  fastify.all('/rpc/*', async (request, reply) => {
    const { matched } = await handler.handle(request, reply, {
      context: {},
      prefix: '/rpc',
    });

    if (!matched) {
      reply.status(404).send('Not found');
    }
  });

  const url = await fastify.listen({
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 0,
  });

  return { server: fastify, url };
}

export function formatReadyLine(url: string) {
  return `${readyPrefix}${JSON.stringify({ url })}`;
}

export function parsePort(value: string | undefined) {
  if (!value) {
    return 0;
  }

  const port = Number.parseInt(value, 10);

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }

  return port;
}
