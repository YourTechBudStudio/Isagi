import { Layer, ManagedRuntime } from 'effect';
import Fastify from 'fastify';

import { registerWorkspaceApi } from '../api.js';
import { WorkspaceService } from '../workspace.service.js';

/**
 * Runs the real workspace routes against a caller-supplied workspace service.
 *
 * Deliberately separate from `test-support.ts`, which holds service doubles and
 * pure fixtures: this module owns Fastify and `ManagedRuntime` lifetimes, and
 * dragging that machinery into the fixture module would make every service test
 * pay for it.
 *
 * The layer is supplied rather than the service value so a suite can hand over
 * either a fake (`Layer.succeed(WorkspaceService, double)`) or the real
 * `WorkspaceServiceLive` graph. Requests go through `fastify.inject`, so nothing
 * ever listens on a port.
 */
export async function withWorkspaceApi<A>(
  layer: Layer.Layer<WorkspaceService>,
  run: (fastify: Fastify.FastifyInstance) => Promise<A>,
) {
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(layer);
  try {
    // Nested rather than sequential in one `finally` so a rejected
    // `fastify.close()` cannot leak the runtime and its borrowed resources.
    try {
      registerWorkspaceApi(fastify, runtime as never);
      await fastify.ready();
      return await run(fastify);
    } finally {
      await fastify.close();
    }
  } finally {
    await runtime.dispose();
  }
}
