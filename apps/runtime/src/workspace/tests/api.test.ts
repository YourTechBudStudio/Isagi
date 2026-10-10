import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer } from 'effect';
import type Fastify from 'fastify';

import type { DeleteWorktreeOutput } from '@isagi/contracts';

import { DatabaseError } from '../../platform/persistence/index.js';
import { ProjectConfigError } from '../../projects/index.js';
import {
  ProjectOrderError,
  WorkspaceError,
  WorkspaceService,
  WorktreeOrderError,
  StateFileError,
} from '../index.js';
import { WorktreeSetupError } from '../setup/service.js';
import { withWorkspaceApi as withWorkspaceApiLayer } from './api-test-support.js';

test('durable session inventory route returns the complete identity set', async () => {
  const sessions = [
    { kind: 'agent_session' as const, sessionId: 7, worktreeId: 2 },
    { kind: 'terminal_session' as const, sessionId: 9, worktreeId: 3 },
  ];
  await withWorkspaceApi({ durableSessions: Effect.succeed({ sessions }) }, async (fastify) => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/v1/workspace/durable-sessions',
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, { sessions });
  });
});

test('worktree delete route decodes params and body through the contract path', async () => {
  let input: {
    readonly projectId: number;
    readonly worktreeId: number;
    readonly request: {
      readonly checkoutRemovalMode: 'normal' | 'force';
      readonly branchRemovalMode: 'preserve' | 'delete_if_safe';
    };
  } | null = null;

  await withWorkspaceApi(
    {
      deleteWorktree: (request) =>
        Effect.sync(() => {
          input = request;
          return deleteWorktreeOutput;
        }),
    },
    async (fastify) => {
      const response = await fastify.inject({
        method: 'DELETE',
        url: '/api/v1/projects/1/worktrees/11',
        payload: {
          checkoutRemovalMode: 'normal',
          branchRemovalMode: 'delete_if_safe',
        },
      });
      const payload = response.json() as { data?: DeleteWorktreeOutput };

      assert.equal(response.statusCode, 200);
      assert.deepEqual(input, {
        projectId: 1,
        worktreeId: 11,
        request: {
          checkoutRemovalMode: 'normal',
          branchRemovalMode: 'delete_if_safe',
        },
      });
      assert.deepEqual(payload.data, deleteWorktreeOutput);
    },
  );
});

test('worktree delete route maps domain failures to delete rejection envelopes', async () => {
  await withWorkspaceApi(
    {
      deleteWorktree: (request) =>
        Effect.fail(
          new WorkspaceError({
            code: 'dirty_checkout_requires_force',
            message: 'Worktree has uncommitted or untracked changes.',
            projectId: request.projectId,
            worktreeId: request.worktreeId,
            path: '/repo/isagi-feature',
          }),
        ),
    },
    async (fastify) => {
      const response = await fastify.inject({
        method: 'DELETE',
        url: '/api/v1/projects/1/worktrees/11',
        payload: {
          checkoutRemovalMode: 'normal',
          branchRemovalMode: 'preserve',
        },
      });
      const payload = response.json() as {
        error?: { readonly code?: string; readonly data?: unknown; readonly requestId?: unknown };
      };

      assert.equal(response.statusCode, 400);
      assert.equal(payload.error?.code, 'worktree_delete_rejected');
      assert.equal(typeof payload.error?.requestId, 'string');
      assert.deepEqual(payload.error?.data, {
        reason: 'dirty_checkout_requires_force',
        projectId: 1,
        worktreeId: 11,
        path: '/repo/isagi-feature',
      });
    },
  );
});

test('worktree delete route maps PTY teardown failures to stable delete rejection reason', async () => {
  await withWorkspaceApi(
    {
      deleteWorktree: (request) =>
        Effect.fail(
          new WorkspaceError({
            code: 'pty_teardown_failed',
            message: 'Could not stop active sessions for that worktree.',
            projectId: request.projectId,
            worktreeId: request.worktreeId,
          }),
        ),
    },
    async (fastify) => {
      const response = await fastify.inject({
        method: 'DELETE',
        url: '/api/v1/projects/1/worktrees/11',
        payload: {
          checkoutRemovalMode: 'normal',
          branchRemovalMode: 'preserve',
        },
      });
      const payload = response.json() as {
        error?: { readonly code?: string; readonly data?: unknown; readonly requestId?: unknown };
      };

      assert.equal(response.statusCode, 400);
      assert.equal(payload.error?.code, 'worktree_delete_rejected');
      assert.equal(typeof payload.error?.requestId, 'string');
      assert.deepEqual(payload.error?.data, {
        reason: 'pty_teardown_failed',
        projectId: 1,
        worktreeId: 11,
      });
    },
  );
});

test('project order route decodes params and a null append anchor', async () => {
  let input: { readonly projectId: number; readonly beforeProjectId: number | null } | null = null;

  await withWorkspaceApi(
    {
      moveProjectOrder: (request) =>
        Effect.sync(() => {
          input = request;
          return { projectId: request.projectId };
        }),
    },
    async (fastify) => {
      const response = await fastify.inject({
        method: 'PUT',
        url: '/api/v1/projects/3/order',
        payload: { beforeProjectId: null },
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(input, { projectId: 3, beforeProjectId: null });
      assert.deepEqual(response.json().data, { projectId: 3 });
    },
  );
});

test('project order route carries an explicit anchor through to the service', async () => {
  let input: { readonly projectId: number; readonly beforeProjectId: number | null } | null = null;

  await withWorkspaceApi(
    {
      moveProjectOrder: (request) =>
        Effect.sync(() => {
          input = request;
          return { projectId: request.projectId };
        }),
    },
    async (fastify) => {
      const response = await fastify.inject({
        method: 'PUT',
        url: '/api/v1/projects/3/order',
        payload: { beforeProjectId: 5 },
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(input, { projectId: 3, beforeProjectId: 5 });
    },
  );
});

test('project order route rejects a body whose anchor is not an identifier', async () => {
  await withWorkspaceApi({}, async (fastify) => {
    const response = await fastify.inject({
      method: 'PUT',
      url: '/api/v1/projects/3/order',
      payload: { beforeProjectId: 'first' },
    });
    const payload = response.json() as { error?: { readonly code?: string } };

    assert.equal(response.statusCode, 400);
    assert.equal(payload.error?.code, 'api_request_decoding_failed');
  });
});

test('project order route maps a missing anchor to a stable rejection envelope', async () => {
  await withWorkspaceApi(
    {
      moveProjectOrder: (request) =>
        Effect.fail(
          new ProjectOrderError({
            reason: 'before_project_not_present',
            message: 'A missing project cannot be used as an insertion anchor.',
            projectId: request.projectId,
            ...(request.beforeProjectId === null
              ? {}
              : { beforeProjectId: request.beforeProjectId }),
          }),
        ),
    },
    async (fastify) => {
      const response = await fastify.inject({
        method: 'PUT',
        url: '/api/v1/projects/3/order',
        payload: { beforeProjectId: 5 },
      });
      const payload = response.json() as {
        error?: { readonly code?: string; readonly data?: unknown; readonly requestId?: unknown };
      };

      assert.equal(response.statusCode, 400);
      assert.equal(payload.error?.code, 'project_order_rejected');
      assert.equal(typeof payload.error?.requestId, 'string');
      assert.deepEqual(payload.error?.data, {
        reason: 'before_project_not_present',
        projectId: 3,
        beforeProjectId: 5,
      });
    },
  );
});

test('worktree order route decodes both path identifiers and the anchor', async () => {
  let input: {
    readonly projectId: number;
    readonly worktreeId: number;
    readonly beforeWorktreeId: number | null;
  } | null = null;

  await withWorkspaceApi(
    {
      moveWorktreeOrder: (request) =>
        Effect.sync(() => {
          input = request;
          return { projectId: request.projectId, worktreeId: request.worktreeId };
        }),
    },
    async (fastify) => {
      const response = await fastify.inject({
        method: 'PUT',
        url: '/api/v1/projects/1/worktrees/11/order',
        payload: { beforeWorktreeId: 12 },
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(input, { projectId: 1, worktreeId: 11, beforeWorktreeId: 12 });
      assert.deepEqual(response.json().data, { projectId: 1, worktreeId: 11 });
    },
  );
});

test('worktree order route reports an attempt to move the root as a stable reason', async () => {
  await withWorkspaceApi(
    {
      moveWorktreeOrder: (request) =>
        Effect.fail(
          new WorktreeOrderError({
            reason: 'root_worktree_fixed',
            message: 'The root worktree is always first and cannot be reordered.',
            projectId: request.projectId,
            worktreeId: request.worktreeId,
          }),
        ),
    },
    async (fastify) => {
      const response = await fastify.inject({
        method: 'PUT',
        url: '/api/v1/projects/1/worktrees/10/order',
        payload: { beforeWorktreeId: null },
      });
      const payload = response.json() as {
        error?: { readonly code?: string; readonly data?: unknown };
      };

      assert.equal(response.statusCode, 400);
      assert.equal(payload.error?.code, 'worktree_order_rejected');
      assert.deepEqual(payload.error?.data, {
        reason: 'root_worktree_fixed',
        projectId: 1,
        worktreeId: 10,
      });
    },
  );
});

test('worktree order route reports a cross-project anchor rather than adopting it', async () => {
  await withWorkspaceApi(
    {
      moveWorktreeOrder: (request) =>
        Effect.fail(
          new WorktreeOrderError({
            reason: 'before_worktree_project_mismatch',
            message: 'The insertion anchor belongs to a different project.',
            projectId: request.projectId,
            worktreeId: request.worktreeId,
            ...(request.beforeWorktreeId === null
              ? {}
              : { beforeWorktreeId: request.beforeWorktreeId }),
          }),
        ),
    },
    async (fastify) => {
      const response = await fastify.inject({
        method: 'PUT',
        url: '/api/v1/projects/1/worktrees/11/order',
        payload: { beforeWorktreeId: 99 },
      });
      const payload = response.json() as {
        error?: { readonly code?: string; readonly data?: unknown };
      };

      assert.equal(response.statusCode, 400);
      assert.equal(payload.error?.code, 'worktree_order_rejected');
      assert.deepEqual(payload.error?.data, {
        reason: 'before_worktree_project_mismatch',
        projectId: 1,
        worktreeId: 11,
        beforeWorktreeId: 99,
      });
    },
  );
});

test('order routes map database failures to the shared runtime envelope', async () => {
  await withWorkspaceApi(
    {
      moveProjectOrder: () =>
        Effect.fail(
          new DatabaseError({ operation: 'move_project_order', cause: new Error('disk is gone') }),
        ),
    },
    async (fastify) => {
      const response = await fastify.inject({
        method: 'PUT',
        url: '/api/v1/projects/3/order',
        payload: { beforeProjectId: null },
      });
      const payload = response.json() as {
        error?: { readonly code?: string; readonly data?: unknown };
      };

      assert.equal(response.statusCode, 500);
      assert.equal(payload.error?.code, 'runtime_database_failed');
      assert.deepEqual(payload.error?.data, { operation: 'move_project_order' });
    },
  );
});

/**
 * The two collision rejections `mode: "create_new"` introduces. Pinned at the boundary and not only
 * in the service, because three separate facts a client depends on are decided here and nowhere
 * else: that the reason survives as itself rather than degrading through
 * `worktreeRejectionReason`'s catch-all default, that a collision answers 409 rather than 400, and
 * that the identifiers a person needs to act on it are carried through.
 */
const worktreeOpenCollisions = [
  {
    label: 'branch_exists',
    error: new WorkspaceError({
      branch: 'feature/new',
      code: 'branch_exists' as const,
      message: 'Branch feature/new already exists in project 1.',
      projectId: 1,
    }),
    expected: { reason: 'branch_exists', projectId: 1, branch: 'feature/new' },
  },
  {
    label: 'worktree_exists',
    error: new WorkspaceError({
      branch: 'feature/new',
      code: 'worktree_exists' as const,
      message: 'Worktree 11 is already checked out on branch feature/new.',
      path: '/data/worktrees/1/abc123',
      projectId: 1,
      worktreeId: 11,
    }),
    expected: {
      reason: 'worktree_exists',
      projectId: 1,
      worktreeId: 11,
      branch: 'feature/new',
      path: '/data/worktrees/1/abc123',
    },
  },
];

for (const collision of worktreeOpenCollisions) {
  test(`worktrees.open answers 409 and carries the identifiers for ${collision.label}`, async () => {
    await withWorkspaceApi(
      { openWorktree: () => Effect.fail(collision.error) },
      async (fastify) => {
        const response = await fastify.inject({
          method: 'POST',
          url: '/api/v1/projects/1/worktrees/open',
          payload: { branch: 'feature/new', mode: 'create_new' },
        });
        const body = response.json() as {
          readonly error?: {
            readonly code?: string;
            readonly data?: Record<string, unknown>;
          };
        };

        assert.equal(response.statusCode, 409);
        assert.equal(body.error?.code, 'worktree_open_rejected');
        assert.deepEqual(body.error?.data, collision.expected);
      },
    );
  });
}

// Command cleanup gates three flows beyond an explicit worktree delete, because
// `cleanupBeforeWorktreePrune` runs inside project reconciliation. Each already
// declares `command_cleanup_failed` in its contract; this pins that the runtime
// actually maps the propagated failure onto the declared envelope rather than
// falling through to a generic 500.
const commandCleanupGatedRoutes = [
  {
    label: 'worktrees.open',
    method: 'POST' as const,
    url: '/api/v1/projects/1/worktrees/open',
    payload: { branch: 'feature/new' },
    service: (error: WorkspaceError): Partial<WorkspaceService['Service']> => ({
      openWorktree: () => Effect.fail(error),
    }),
    code: 'worktree_open_rejected',
  },
  {
    label: 'projects.add',
    method: 'POST' as const,
    url: '/api/v1/projects',
    payload: { path: '/repo/isagi' },
    service: (error: WorkspaceError): Partial<WorkspaceService['Service']> => ({
      registerProject: () => Effect.fail(error),
    }),
    code: 'project_operation_rejected',
  },
  {
    label: 'workspace.reconcile',
    method: 'POST' as const,
    url: '/api/v1/workspace/reconcile',
    payload: { projectId: 1 },
    service: (error: WorkspaceError): Partial<WorkspaceService['Service']> => ({
      reconcileWorkspace: () => Effect.fail(error),
    }),
    code: 'workspace_reconcile_rejected',
  },
];

for (const route of commandCleanupGatedRoutes) {
  test(`${route.label} maps a command cleanup failure onto its declared envelope`, async () => {
    const error = new WorkspaceError({
      code: 'command_cleanup_failed',
      message: 'Could not stop running commands for worktree 11.',
      projectId: 1,
      worktreeId: 11,
    });

    await withWorkspaceApi(route.service(error), async (fastify) => {
      const response = await fastify.inject({
        method: route.method,
        url: route.url,
        payload: route.payload,
      });
      const body = response.json() as {
        readonly error?: { readonly code?: string; readonly data?: { readonly reason?: string } };
      };

      assert.equal(response.statusCode, 400);
      assert.equal(body.error?.code, route.code);
      assert.equal(body.error?.data?.reason, 'command_cleanup_failed');
    });
  });
}

test('projects.relocate answers an already-registered path with 409 and the conflicting project', async () => {
  await withWorkspaceApi(
    {
      relocateProject: (input) =>
        Effect.fail(
          new WorkspaceError({
            code: 'project_path_already_registered',
            message: 'Project path /repo/other is already registered.',
            conflictingProjectId: 4,
            path: '/repo/other',
            projectId: input.projectId,
          }),
        ),
    },
    async (fastify) => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/projects/3/relocate',
        payload: { path: '/repo/other' },
      });
      const body = response.json() as ErrorBody;

      assert.equal(response.statusCode, 409);
      assert.equal(body.error?.code, 'project_relocation_rejected');
      assert.deepEqual(body.error?.data, {
        reason: 'project_path_already_registered',
        projectId: 3,
        path: '/repo/other',
        conflictingProjectId: 4,
      });
    },
  );
});

test('setup routes report an invalid project configuration as worktree_setup_rejected', async () => {
  await withWorkspaceApi(
    {
      preflightWorktreeSetup: (input) =>
        Effect.fail(
          new ProjectConfigError({
            code: 'setup_config_invalid',
            message: 'The project configuration is not valid.',
            path: '/repo/isagi/.isagi/config.yaml',
            projectId: input.projectId,
          }),
        ),
    },
    async (fastify) => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/projects/1/worktrees/setup/preflight',
      });
      const body = response.json() as ErrorBody;

      assert.equal(response.statusCode, 400);
      assert.equal(body.error?.code, 'worktree_setup_rejected');
      assert.deepEqual(body.error?.data, { reason: 'setup_config_invalid', projectId: 1 });
    },
  );
});

test('worktrees.open reports a setup trust refusal as part of opening', async () => {
  await withWorkspaceApi(
    {
      openWorktree: (input) =>
        Effect.fail(
          new WorktreeSetupError({
            code: 'setup_trust_required',
            message: 'Approve this project’s worktree setup hooks before creating the worktree.',
            hash: 'abc',
            projectId: input.projectId,
          }),
        ),
    },
    async (fastify) => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/projects/1/worktrees/open',
        payload: { branch: 'feature/new' },
      });
      const body = response.json() as ErrorBody;

      assert.equal(response.statusCode, 400);
      assert.equal(body.error?.code, 'worktree_open_rejected');
      assert.deepEqual(body.error?.data, { reason: 'setup_trust_required', projectId: 1 });
    },
  );
});

test('active context route reports a worktree outside the project as a stable rejection', async () => {
  await withWorkspaceApi(
    {
      setActiveContext: (input) =>
        Effect.fail(
          new WorkspaceError({
            code: 'worktree_not_found',
            message: 'Worktree 99 was not found for project 1.',
            projectId: input.activeContext.projectId ?? undefined,
            worktreeId: input.activeContext.worktreeId ?? undefined,
          }),
        ),
    },
    async (fastify) => {
      const response = await fastify.inject({
        method: 'PUT',
        url: '/api/v1/workspace/active-context',
        payload: { activeContext: { projectId: 1, worktreeId: 99 }, revision: 3 },
      });
      const body = response.json() as ErrorBody;

      assert.equal(response.statusCode, 400);
      assert.equal(body.error?.code, 'workspace_active_context_rejected');
      assert.deepEqual(body.error?.data, {
        reason: 'worktree_not_found',
        projectId: 1,
        worktreeId: 99,
      });
    },
  );
});

test('workspace snapshot route reports a state file failure as the shared state file envelope', async () => {
  await withWorkspaceApi(
    {
      get: Effect.fail(
        new StateFileError({ operation: 'read_state_file', cause: new Error('EIO') }),
      ),
    },
    async (fastify) => {
      const response = await fastify.inject({ method: 'GET', url: '/api/v1/workspace' });
      const body = response.json() as ErrorBody;

      assert.equal(response.statusCode, 500);
      assert.equal(body.error?.code, 'runtime_state_file_failed');
      assert.deepEqual(body.error?.data, { operation: 'read_state_file' });
    },
  );
});

/**
 * A code the endpoint's own method never produces is a runtime bug, not a rejection to relabel: before typed routes it
 * fell through a catch-all to some other reason or to `api_response_encoding_failed`.
 */
test('a workspace failure the route cannot produce answers api_unhandled_error', async () => {
  await withWorkspaceApi(
    {
      deleteProject: (projectId) =>
        Effect.fail(
          new WorkspaceError({
            code: 'branch_exists',
            message: 'Branch feature/new already exists.',
            projectId,
          }),
        ),
    },
    async (fastify) => {
      const response = await fastify.inject({ method: 'DELETE', url: '/api/v1/projects/1' });
      const body = response.json() as ErrorBody;

      assert.equal(response.statusCode, 500);
      assert.equal(body.error?.code, 'api_unhandled_error');
      assert.equal(body.error?.message, 'Branch feature/new already exists.');
    },
  );
});

interface ErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string; readonly data?: unknown };
}

/**
 * Runs the real workspace routes against a partial service: members a test does not provide die as unimplemented, so
 * a route that calls an unexpected method fails loudly.
 */
function withWorkspaceApi<A>(
  service: Partial<WorkspaceService['Service']>,
  run: (fastify: Fastify.FastifyInstance) => Promise<A>,
) {
  return withWorkspaceApiLayer(Layer.mock(WorkspaceService, service), run);
}

const deleteWorktreeOutput = {
  projectId: 1,
  deletedWorktreeId: 11,
  selectedWorktreeId: 10,
  branchRemoval: {
    status: 'deleted',
    branch: 'feature/delete-me',
  },
} satisfies DeleteWorktreeOutput;
