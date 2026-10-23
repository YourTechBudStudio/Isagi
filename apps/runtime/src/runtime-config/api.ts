import { Effect } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints, type ClientSettingsOutput } from '@isagi/contracts';

import { registerApiEndpoint, type RouteRuntime } from '../platform/http/index.js';
import { RuntimeConfig } from './service.js';

/** The runtime-config module's routes: client settings. It has no module layer; `RuntimeConfig` is a platform service. */
export function registerRuntimeConfigRoutes(
  fastify: FastifyInstance,
  runtime: RouteRuntime<RuntimeConfig>,
) {
  // Reading the live config cannot fail: the service decoded `config.yaml` when it was built.
  registerApiEndpoint(fastify, runtime, apiEndpoints.clientSettings, () =>
    RuntimeConfig.use((runtimeConfig) => runtimeConfig.get).pipe(
      Effect.map((config): ClientSettingsOutput => ({
        terminal: {
          scrollbackLines: config.terminal.scrollbackLines,
          cache: {
            idleTtlMinutes: config.terminal.cache.idleTtlMinutes,
            maxHiddenSessions: config.terminal.cache.maxHiddenSessions,
            maxEstimatedBufferMiB: config.terminal.cache.maxEstimatedBufferMiB,
          },
        },
        appearance: { theme: config.appearance.theme },
      })),
    ),
  );
}
