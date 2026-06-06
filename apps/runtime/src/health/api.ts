import { Effect } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints } from '@isagi/contracts';

import { getRuntimeHealth } from '../health.js';
import { registerApiEndpoint } from '../lib/api/index.js';

export function registerHealthApi(fastify: FastifyInstance) {
  registerApiEndpoint(fastify, apiEndpoints.health, {
    handle: () => getRuntimeHealth(),
    run: Effect.runPromise,
  });
}
