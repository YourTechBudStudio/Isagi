import { Effect, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints, type ClientSettingsOutput } from '@isagi/contracts';

import { registerApiEndpoint } from '../lib/api/index.js';
import { RuntimeConfig } from '../runtime-config/index.js';
import type { RuntimeServices } from '../runtime.layer.js';

export function registerClientSettingsApi(
  fastify: FastifyInstance,
  runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>,
) {
  const run = <A>(
    effect: Effect.Effect<A, unknown, RuntimeServices>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) => runtime.runPromise(effect, options);
  registerApiEndpoint(fastify, apiEndpoints.clientSettings, {
    handle: () =>
      Effect.gen(function* () {
        const runtimeConfig = yield* RuntimeConfig;
        const config = yield* runtimeConfig.get;
        return {
          terminal: {
            scrollbackLines: config.terminal.scrollbackLines,
            cache: {
              idleTtlMinutes: config.terminal.cache.idleTtlMinutes,
              maxHiddenSessions: config.terminal.cache.maxHiddenSessions,
              maxEstimatedBufferMiB: config.terminal.cache.maxEstimatedBufferMiB,
            },
          },
        } satisfies ClientSettingsOutput;
      }),
    run,
  });
}
