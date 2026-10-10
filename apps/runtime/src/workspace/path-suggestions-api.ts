import { Effect } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints } from '@isagi/contracts';

import { suggestPaths } from '../paths/index.js';
import { registerApiEndpoint } from '../platform/http/index.js';

export function registerPathsApi(fastify: FastifyInstance) {
  registerApiEndpoint(fastify, apiEndpoints.paths.suggestions, {
    handle: (input) => suggestPaths(input),
    run: Effect.runPromise,
  });
}
