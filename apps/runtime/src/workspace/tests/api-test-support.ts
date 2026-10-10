import type { Layer } from 'effect';
import type { FastifyInstance } from 'fastify';

import { withApiServer } from '../../platform/http/testing.js';
import { registerWorkspaceApi } from '../api.js';
import type { WorkspaceService } from '../service.js';

/**
 * Runs the real workspace routes against a caller-supplied workspace service.
 *
 * Deliberately separate from `test-support.ts`, which holds service doubles and
 * pure fixtures: this module owns the API server's lifetime, and dragging that
 * machinery into the fixture module would make every service test pay for it.
 *
 * The layer is supplied rather than the service value so a suite can hand over
 * either a fake (`Layer.succeed(WorkspaceService, double)`) or the real
 * `WorkspaceService.layerNoDeps` graph. Requests go through `fastify.inject`, so nothing
 * ever listens on a port.
 */
export function withWorkspaceApi<A>(
  layer: Layer.Layer<WorkspaceService>,
  run: (fastify: FastifyInstance) => Promise<A>,
) {
  return withApiServer(layer, registerWorkspaceApi, run);
}
