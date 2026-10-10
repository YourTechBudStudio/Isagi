import type { FastifyInstance } from 'fastify';

import { apiEndpoints } from '@isagi/contracts';

import { registerLegacyApiEndpoint, type RouteRuntime } from '../platform/http/index.js';
import { suggestPaths } from './path-suggestions.js';

/** Path suggestions read only the filesystem, so they need no runtime service. */
export function registerPathsApi(fastify: FastifyInstance, runtime: RouteRuntime<never>) {
  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.paths.suggestions, {
    handle: (input) => suggestPaths(input),
  });
}
