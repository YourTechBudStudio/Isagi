import type { FastifyInstance } from 'fastify';

import { registerCommandsRoutes } from '../commands/index.js';
import { registerEditorRoutes } from '../editor/index.js';
import { registerEnvironmentRoutes } from '../environment/index.js';
import { registerFluidcastRoutes } from '../fluidcast/index.js';
import { registerHarnessesRoutes } from '../harnesses/index.js';
import type { RouteRuntime } from '../platform/http/index.js';
import { registerRuntimeConfigRoutes } from '../runtime-config/index.js';
import { registerRuntimeEventsRoutes } from '../runtime-events/index.js';
import { registerWorkflowsRoutes } from '../workflows/index.js';
import { registerWorkspaceRoutes } from '../workspace/index.js';
import { registerHealthRoutes } from './health.js';
import type { RuntimeServices } from './layer.js';

/**
 * Every runtime route: the runtime's own health route, then each module's routes. Each registrar takes the narrower
 * `RouteRuntime` its module needs; the server's runtime provides every service, so it fits all of them.
 */
export function registerRuntimeRoutes(
  fastify: FastifyInstance,
  runtime: RouteRuntime<RuntimeServices>,
) {
  registerHealthRoutes(fastify, runtime);
  registerEnvironmentRoutes(fastify, runtime);
  registerRuntimeConfigRoutes(fastify, runtime);
  registerHarnessesRoutes(fastify, runtime);
  registerCommandsRoutes(fastify, runtime);
  registerWorkspaceRoutes(fastify, runtime);
  registerRuntimeEventsRoutes(fastify, runtime);
  registerEditorRoutes(fastify, runtime);
  registerWorkflowsRoutes(fastify, runtime);
  registerFluidcastRoutes(fastify, runtime);
}
