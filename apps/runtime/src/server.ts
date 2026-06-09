import process from 'node:process';

import cors from '@fastify/cors';
import { Effect, ManagedRuntime } from 'effect';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerHealthApi } from './health/api.js';
import { sendApiError } from './lib/api/index.js';
import { registerPathsApi } from './paths/api.js';
import { RuntimeLayer } from './runtime.layer.js';
import { registerSurfacesApi } from './surfaces/index.js';
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
      yield* tryPromise(() => runtime.runtime());

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
          methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'OPTIONS'],
          origin: (origin, callback) => {
            callback(null, isAllowedRuntimeOrigin(origin));
          },
        }),
      );

      registerHealthApi(fastify);
      registerWorkspaceApi(fastify, runtime);
      registerSurfacesApi(fastify, runtime);
      registerPathsApi(fastify);

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
