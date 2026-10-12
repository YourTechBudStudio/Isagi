import assert from 'node:assert/strict';
import test from 'node:test';

import { Context, Data, Effect } from 'effect';
import Fastify, { type FastifyInstance } from 'fastify';

import { apiEndpoints, type ApiError } from '@isagi/contracts';

import { GitCommandError } from '../git/index.js';
import { DatabaseError } from '../persistence/index.js';
import { registerApiEndpoint } from './endpoint.js';
import type { RouteRuntime } from './route-runtime.js';
import { serviceFreeRouteRuntime } from './testing.js';

/**
 * The handler's error channel is the contract: each `@ts-expect-error` below is a mistake `tsc` must reject at the
 * handler (`pnpm typecheck` fails if any of them compiles). `projects.delete` declares `project_delete_rejected` and
 * the storage failures, but not `git_command_failed`.
 */

class ProjectNotFound extends Data.TaggedError('ProjectNotFound')<{ readonly projectId: number }> {}
class Projects extends Context.Service<Projects, { readonly ping: Effect.Effect<void> }>()(
  'isagi/runtime/platform/http/test/Projects',
) {}

const gitFailure = () =>
  new GitCommandError({
    args: ['status'],
    cwd: undefined,
    cause: null,
    failure: { kind: 'exited', exitCode: 128 },
    stderr: '',
  });

export function handlerTypingMistakes(fastify: FastifyInstance, runtime: RouteRuntime<never>) {
  registerApiEndpoint(fastify, runtime, apiEndpoints.projects.delete, (request) =>
    // @ts-expect-error a domain error left unmapped is not a HandlerError
    Effect.fail(new ProjectNotFound({ projectId: request.params.projectId })),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.projects.delete, () =>
    // @ts-expect-error projects.delete does not declare git_command_failed
    Effect.fail(gitFailure()),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.projects.delete, (request) =>
    request.reject({
      code: 'project_delete_rejected',
      status: 400,
      message: 'Commands could not be stopped.',
      // @ts-expect-error "made_up" is not a declared reason
      data: { reason: 'made_up', projectId: request.params.projectId },
    }),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.projects.delete, () =>
    // @ts-expect-error the runtime does not provide the Projects service the handler needs
    Projects.use((projects) => projects.ping).pipe(Effect.as({ projectId: 1, deleted: true })),
  );
}

test('a declared infrastructure error passes through a handler untouched', async () => {
  const fastify = Fastify({ logger: false });
  registerApiEndpoint(fastify, serviceFreeRouteRuntime, apiEndpoints.projects.delete, () =>
    Effect.fail(new DatabaseError({ operation: 'delete_project', cause: null })),
  );

  try {
    const response = await fastify.inject({ method: 'DELETE', url: '/api/v1/projects/7' });
    const payload = response.json() as { error?: ApiError };

    assert.equal(response.statusCode, 500);
    assert.equal(payload.error?.code, 'runtime_database_failed');
    assert.equal(typeof handlerTypingMistakes, 'function');
  } finally {
    await fastify.close();
  }
});
