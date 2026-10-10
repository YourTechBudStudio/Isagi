import process from 'node:process';

import { Effect } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints } from '@isagi/contracts';

import { runtimePackageVersion } from '../platform/assets/index.js';
import { registerApiEndpoint, type RouteRuntime } from '../platform/http/index.js';

export function getRuntimeHealth() {
  return Effect.sync(() => ({
    context: {
      arch: process.arch,
      node: process.version,
      pid: process.pid,
      platform: process.platform,
    },
    name: 'isagi-runtime' as const,
    ok: true as const,
    timestamp: new Date().toISOString(),
    // Recorded in the asset manifest from the runtime's `package.json` at build time.
    version: runtimePackageVersion,
  }));
}

/** The one route `app/` owns: the runtime describing itself. It needs no service. */
export function registerHealthRoutes(fastify: FastifyInstance, runtime: RouteRuntime<never>) {
  registerApiEndpoint(fastify, runtime, apiEndpoints.health, () => getRuntimeHealth());
}
