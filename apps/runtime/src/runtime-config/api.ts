import { Effect } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints, type ClientSettingsOutput } from '@isagi/contracts';

import { registerLegacyApiEndpoint, type RouteRuntime } from '../platform/http/index.js';
import { RuntimeConfig } from './service.js';

/** The runtime-config module's routes: client settings. It has no module layer; `RuntimeConfig` is a platform service. */
export function registerRuntimeConfigRoutes(
  fastify: FastifyInstance,
  runtime: RouteRuntime<RuntimeConfig>,
) {
  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.clientSettings, {
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
  });
}
