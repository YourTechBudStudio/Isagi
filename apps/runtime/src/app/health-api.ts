import { Effect } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints } from '@isagi/contracts';

import { registerApiEndpoint } from '../platform/http/index.js';
import { getRuntimeHealth } from './health.js';

export function registerHealthApi(fastify: FastifyInstance) {
  registerApiEndpoint(fastify, apiEndpoints.health, {
    handle: () => getRuntimeHealth(),
    run: Effect.runPromise,
  });
}
