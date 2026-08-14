import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer, ManagedRuntime } from 'effect';
import Fastify from 'fastify';

import type { DeleteWorktreeOutput, WorkspaceSnapshot } from '@isagi/contracts';

import { DatabaseError } from '../../persistence/index.js';
import { registerWorkspaceApi } from '../api.js';
import {
  ProjectOrderError,
  WorkspaceError,
  WorkspaceService,
  WorktreeOrderError,
  type WorkspaceServiceShape,
} from '../index.js';

test('durable session inventory route returns the complete identity set', async () => {
  const sessions = [
    { kind: 'agent_session' as const, sessionId: 7, worktreeId: 2 },
    { kind: 'terminal_session' as const, sessionId: 9, worktreeId: 3 },
  ];
  await withWorkspaceApi(
    fakeWorkspaceService({ durableSessions: Effect.succeed({ sessions }) }),
    async (fastify) => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/api/v1/workspace/durable-sessions',
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().data, { sessions });
    },
  );
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
    fakeWorkspaceService({
      deleteWorktree: (request) =>
        Effect.sync(() => {
          input = request;
          return deleteWorktreeOutput;
        }),
    }),
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
    fakeWorkspaceService({
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
    }),
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
    fakeWorkspaceService({
      deleteWorktree: (request) =>
        Effect.fail(
          new WorkspaceError({
            code: 'pty_teardown_failed',
            message: 'Could not stop active sessions for that worktree.',
            projectId: request.projectId,
            worktreeId: request.worktreeId,
          }),
        ),
    }),
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
    fakeWorkspaceService({
      moveProjectOrder: (request) =>
        Effect.sync(() => {
          input = request;
          return { projectId: request.projectId };
        }),
    }),
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
    fakeWorkspaceService({
      moveProjectOrder: (request) =>
        Effect.sync(() => {
          input = request;
          return { projectId: request.projectId };
        }),
    }),
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
  await withWorkspaceApi(fakeWorkspaceService(), async (fastify) => {
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
    fakeWorkspaceService({
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
    }),
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
    fakeWorkspaceService({
      moveWorktreeOrder: (request) =>
        Effect.sync(() => {
          input = request;
          return { projectId: request.projectId, worktreeId: request.worktreeId };
        }),
    }),
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
    fakeWorkspaceService({
      moveWorktreeOrder: (request) =>
        Effect.fail(
          new WorktreeOrderError({
            reason: 'root_worktree_fixed',
            message: 'The root worktree is always first and cannot be reordered.',
            projectId: request.projectId,
            worktreeId: request.worktreeId,
          }),
        ),
    }),
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
    fakeWorkspaceService({
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
    }),
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
    fakeWorkspaceService({
      moveProjectOrder: () =>
        Effect.fail(
          new DatabaseError({ operation: 'move_project_order', cause: new Error('disk is gone') }),
        ),
    }),
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

async function withWorkspaceApi<A>(
  service: WorkspaceServiceShape,
  run: (fastify: Fastify.FastifyInstance) => Promise<A>,
) {
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(Layer.succeed(WorkspaceService, service));
  try {
    registerWorkspaceApi(fastify, runtime as never);
    await fastify.ready();
    return await run(fastify);
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
}

function fakeWorkspaceService(
  overrides: Partial<WorkspaceServiceShape> = {},
): WorkspaceServiceShape {
  return {
    get: Effect.succeed(workspaceSnapshot),
    durableSessions: Effect.succeed({ sessions: [] }),
    deleteProject: () => Effect.die('deleteProject is not used by workspace API tests'),
    getActiveContext: Effect.succeed({ activeContext: { projectId: null, worktreeId: null } }),
    listProjectBranches: () => Effect.succeed({ branches: [] }),
    preflightWorktreeSetup: (input) =>
      Effect.succeed({ projectId: input.projectId, status: 'not_configured', summary: [] }),
    trustWorktreeSetup: () => Effect.die('trustWorktreeSetup is not used by workspace API tests'),
    openWorktree: () => Effect.die('openWorktree is not used by workspace API tests'),
    preflightDeleteWorktree: (input) =>
      Effect.succeed({
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        path: '/repo/isagi-feature',
        branch: 'feature/delete-me',
        isRoot: false,
        dirty: false,
      }),
    deleteWorktree: () => Effect.succeed(deleteWorktreeOutput),
    registerProject: () => Effect.die('registerProject is not used by workspace API tests'),
    relocateProject: () => Effect.die('relocateProject is not used by workspace API tests'),
    reconcileWorkspace: () => Effect.die('reconcileWorkspace is not used by workspace API tests'),
    setActiveContext: () => Effect.die('setActiveContext is not used by workspace API tests'),
    moveProjectOrder: (input) => Effect.succeed({ projectId: input.projectId }),
    moveWorktreeOrder: (input) =>
      Effect.succeed({ projectId: input.projectId, worktreeId: input.worktreeId }),
    ...overrides,
  };
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

const workspaceSnapshot = {
  projects: [],
} satisfies WorkspaceSnapshot;
