import { Effect } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints } from '@isagi/contracts';

import { registerApiEndpoint } from '../lib/api/index.js';
import { suggestPaths } from './index.js';

export function registerPathsApi(fastify: FastifyInstance) {
  registerApiEndpoint(fastify, apiEndpoints.paths.suggestions, {
    handle: (input) => suggestPaths(input),
    run: Effect.runPromise,
  });
}
