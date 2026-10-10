import type { Layer } from 'effect';
import type { FastifyInstance } from 'fastify';

import type { RouteRuntime } from '../platform/http/index.js';
import type { PtyService } from '../pty-processes/index.js';
import { registerAgentSessionsApi } from './agent-sessions/api.js';
import type { EnvironmentLayer } from './layer.js';
import { registerPtyApi } from './sessions/attach-route.js';
import { registerSurfacesApi } from './surfaces/api.js';

/**
 * The environment module's routes: surfaces (including `editor.open`), agent-session activity, and the agent and
 * terminal session attach sockets. Typed by the module's own layer plus `PtyService`, which the attach sockets stream
 * from, so the module never imports the composition root.
 */
export function registerEnvironmentRoutes(
  fastify: FastifyInstance,
  runtime: RouteRuntime<Layer.Success<typeof EnvironmentLayer> | PtyService>,
) {
  registerAgentSessionsApi(fastify, runtime);
  registerSurfacesApi(fastify, runtime);
  registerPtyApi(fastify, runtime);
}
