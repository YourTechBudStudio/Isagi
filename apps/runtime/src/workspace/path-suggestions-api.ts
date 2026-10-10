import type { FastifyInstance } from 'fastify';

import { apiEndpoints } from '@isagi/contracts';

import { registerApiEndpoint, type RouteRuntime } from '../platform/http/index.js';
import { suggestPaths } from './path-suggestions.js';

/**
 * Path suggestions read only the filesystem, so they need no runtime service, and they cannot fail: an unreadable base
 * is an empty listing.
 */
export function registerPathsApi(fastify: FastifyInstance, runtime: RouteRuntime<never>) {
  registerApiEndpoint(fastify, runtime, apiEndpoints.paths.suggestions, (request) =>
    suggestPaths(request.body),
  );
}
