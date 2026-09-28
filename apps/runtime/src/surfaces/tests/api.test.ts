import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer, ManagedRuntime } from 'effect';
import Fastify from 'fastify';

import type {
  CreateSurfaceOutput,
  DeleteSurfaceOutput,
  RenameSurfaceOutput,
  SetSplitWeightsOutput,
  SurfaceDetail,
} from '@isagi/contracts';

import { registerSurfacesApi } from '../api.js';
import {
  SurfaceError,
  SurfaceOrderError,
  SurfaceService,
  type SurfaceServiceShape,
} from '../index.js';

test('surface rename route decodes params and body through the contract path', async () => {
  let input: { readonly surfaceId: number; readonly title: string } | null = null;
  await withSurfacesApi(
    fakeSurfaceService({
      renameSurface: (request) =>
        Effect.sync(() => {
          input = request;
          return { surfaceId: request.surfaceId, title: request.title.trim() };
        }),
    }),
    async (fastify) => {
      const response = await fastify.inject({
        method: 'PUT',
        url: '/api/v1/surfaces/42/title',
        payload: { title: '  Work  ' },
      });
      const payload = response.json() as { data?: RenameSurfaceOutput };

      assert.equal(response.statusCode, 200);
      assert.deepEqual(input, { surfaceId: 42, title: '  Work  ' });
      assert.deepEqual(payload.data, { surfaceId: 42, title: 'Work' });
    },
  );
});

test('surface delete route returns contract delete output', async () => {
  await withSurfacesApi(
    fakeSurfaceService({
      deleteSurface: (surfaceId) =>
        Effect.succeed({
          deletedSurfaceId: surfaceId,
          deletedPaneIds: [7, 8],
        }),
    }),
    async (fastify) => {
      const response = await fastify.inject({
        method: 'DELETE',
        url: '/api/v1/surfaces/42',
      });
      const payload = response.json() as { data?: DeleteSurfaceOutput };

      assert.equal(response.statusCode, 200);
      assert.deepEqual(payload.data, {
        deletedSurfaceId: 42,
        deletedPaneIds: [7, 8],
      });
    },
  );
});

test('surface pane delete route decodes both route params', async () => {
  let input: { readonly surfaceId: number; readonly paneId: number } | null = null;
  await withSurfacesApi(
    fakeSurfaceService({
      deleteSurfacePane: (request) =>
        Effect.sync(() => {
          input = request;
          return {
            deletedSurfaceId: null,
            deletedPaneIds: [request.paneId],
          };
        }),
    }),
    async (fastify) => {
      const response = await fastify.inject({
        method: 'DELETE',
        url: '/api/v1/surfaces/42/panes/7',
      });
      const payload = response.json() as { data?: DeleteSurfaceOutput };

      assert.equal(response.statusCode, 200);
      assert.deepEqual(input, { surfaceId: 42, paneId: 7 });
      assert.deepEqual(payload.data, {
        deletedSurfaceId: null,
        deletedPaneIds: [7],
      });
    },
  );
});

test('surface creation route decodes initial pane through the contract path', async () => {
  let input: Parameters<SurfaceServiceShape['createSurface']>[0] | null = null;
  await withSurfacesApi(
    fakeSurfaceService({
      createSurface: (request) =>
        Effect.sync(() => {
          input = request;
          return {
            worktreeId: request.worktreeId,
            surfaceId: 42,
            paneId: 7,
            title: 'OpenCode',
          };
        }),
    }),
    async (fastify) => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/worktrees/10/surfaces',
        payload: { initialPane: { kind: 'agent_session', harness: 'opencode' } },
      });
      const payload = response.json() as { data?: CreateSurfaceOutput };

      assert.equal(response.statusCode, 200);
      assert.deepEqual(input, {
        worktreeId: 10,
        initialPane: { kind: 'agent_session', harness: 'opencode' },
      });
      assert.deepEqual(payload.data, {
        worktreeId: 10,
        surfaceId: 42,
        paneId: 7,
        title: 'OpenCode',
      });
    },
  );
});

test('split pane route decodes the source pane and new pane spec through the contract path', async () => {
  let input: Parameters<SurfaceServiceShape['splitPane']>[0] | null = null;
  await withSurfacesApi(
    fakeSurfaceService({
      splitPane: (request) =>
        Effect.sync(() => {
          input = request;
          return {
            worktreeId: request.worktreeId,
            surfaceId: 42,
            paneId: 8,
            title: 'Terminal 2',
          };
        }),
    }),
    async (fastify) => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/worktrees/10/pane-splits',
        payload: {
          paneId: 7,
          direction: 'right',
          newPane: { kind: 'terminal_session' },
        },
      });
      const payload = response.json() as { data?: CreateSurfaceOutput };

      assert.equal(response.statusCode, 200);
      assert.deepEqual(input, {
        worktreeId: 10,
        split: {
          paneId: 7,
          direction: 'right',
          newPane: { kind: 'terminal_session' },
        },
      });
      assert.deepEqual(payload.data, {
        worktreeId: 10,
        surfaceId: 42,
        paneId: 8,
        title: 'Terminal 2',
      });
    },
  );
});

test('set split weights route decodes body and params through the contract path', async () => {
  let input: Parameters<SurfaceServiceShape['setSplitWeights']>[0] | null = null;
  await withSurfacesApi(
    fakeSurfaceService({
      setSplitWeights: (request) =>
        Effect.sync(() => {
          input = request;
          return {
            surfaceId: request.surfaceId,
            layout: {
              kind: 'split',
              nodeId: request.weights.nodeId,
              axis: 'row',
              sizing: 'manual',
              children: [
                { kind: 'leaf', nodeId: 'pane-7', paneId: 7, collapsed: false },
                { kind: 'leaf', nodeId: 'pane-8', paneId: 8, collapsed: false },
              ],
              weights: request.weights.weights,
            },
          };
        }),
    }),
    async (fastify) => {
      const response = await fastify.inject({
        method: 'PUT',
        url: '/api/v1/surfaces/42/layout/weights',
        payload: { nodeId: 'split-8', weights: [0.25, 0.75] },
      });
      const payload = response.json() as { data?: SetSplitWeightsOutput };

      assert.equal(response.statusCode, 200);
      assert.deepEqual(input, {
        surfaceId: 42,
        weights: { nodeId: 'split-8', weights: [0.25, 0.75] },
      });
      assert.deepEqual(payload.data?.layout, {
        kind: 'split',
        nodeId: 'split-8',
        axis: 'row',
        sizing: 'manual',
        children: [
          { kind: 'leaf', nodeId: 'pane-7', paneId: 7, collapsed: false },
          { kind: 'leaf', nodeId: 'pane-8', paneId: 8, collapsed: false },
        ],
        weights: [0.25, 0.75],
      });
    },
  );
});

test('surface API maps invalid title failures to surface_rejected contract errors', async () => {
  await withSurfacesApi(
    fakeSurfaceService({
      renameSurface: (request) =>
        Effect.fail(
          new SurfaceError({
            code: 'invalid_surface_title',
            message: 'Surface title must be between 1 and 80 characters.',
            surfaceId: request.surfaceId,
          }),
        ),
    }),
    async (fastify) => {
      const response = await fastify.inject({
        method: 'PUT',
        url: '/api/v1/surfaces/42/title',
        payload: { title: '   ' },
      });
      const payload = response.json() as {
        error?: { readonly code?: string; readonly data?: unknown; readonly requestId?: unknown };
      };

      assert.equal(response.statusCode, 400);
      assert.equal(payload.error?.code, 'surface_rejected');
      assert.equal(typeof payload.error?.requestId, 'string');
      assert.deepEqual(payload.error?.data, {
        reason: 'invalid_surface_title',
        surfaceId: 42,
      });
    },
  );
});

test('surface API maps stale layout nodes to surface_rejected contract errors', async () => {
  await withSurfacesApi(
    fakeSurfaceService({
      setSplitWeights: (request) =>
        Effect.fail(
          new SurfaceError({
            code: 'layout_node_stale',
            message: `Layout node ${request.weights.nodeId} is stale.`,
            surfaceId: request.surfaceId,
          }),
        ),
    }),
    async (fastify) => {
      const response = await fastify.inject({
        method: 'PUT',
        url: '/api/v1/surfaces/42/layout/weights',
        payload: { nodeId: 'split-8', weights: [0.25, 0.75] },
      });
      const payload = response.json() as {
        error?: { readonly code?: string; readonly data?: unknown; readonly requestId?: unknown };
      };

      assert.equal(response.statusCode, 400);
      assert.equal(payload.error?.code, 'surface_rejected');
      assert.equal(typeof payload.error?.requestId, 'string');
      assert.deepEqual(payload.error?.data, {
        reason: 'layout_node_stale',
        surfaceId: 42,
      });
    },
  );
});

test('surface API maps pane failures to surface_rejected contract errors', async () => {
  await withSurfacesApi(
    fakeSurfaceService({
      deleteSurfacePane: (request) =>
        Effect.fail(
          new SurfaceError({
            code: 'pane_not_found',
            message: `Pane ${request.paneId} was not found for surface ${request.surfaceId}.`,
            surfaceId: request.surfaceId,
            paneId: request.paneId,
          }),
        ),
    }),
    async (fastify) => {
      const response = await fastify.inject({
        method: 'DELETE',
        url: '/api/v1/surfaces/42/panes/7',
      });
      const payload = response.json() as {
        error?: { readonly code?: string; readonly data?: unknown; readonly requestId?: unknown };
      };

      assert.equal(response.statusCode, 400);
      assert.equal(payload.error?.code, 'surface_rejected');
      assert.equal(typeof payload.error?.requestId, 'string');
      assert.deepEqual(payload.error?.data, {
        reason: 'pane_not_found',
        surfaceId: 42,
        paneId: 7,
      });
    },
  );
});

test('surface order route decodes the parent worktree, the surface, and a null anchor', async () => {
  let input: {
    readonly worktreeId: number;
    readonly surfaceId: number;
    readonly beforeSurfaceId: number | null;
  } | null = null;

  await withSurfacesApi(
    fakeSurfaceService({
      moveSurfaceOrder: (request) =>
        Effect.sync(() => {
          input = request;
          return { worktreeId: request.worktreeId, surfaceId: request.surfaceId };
        }),
    }),
    async (fastify) => {
      const response = await fastify.inject({
        method: 'PUT',
        url: '/api/v1/worktrees/10/surfaces/42/order',
        payload: { beforeSurfaceId: null },
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(input, { worktreeId: 10, surfaceId: 42, beforeSurfaceId: null });
      assert.deepEqual(response.json().data, { worktreeId: 10, surfaceId: 42 });
    },
  );
});

test('surface order route carries an explicit anchor through to the service', async () => {
  let input: {
    readonly worktreeId: number;
    readonly surfaceId: number;
    readonly beforeSurfaceId: number | null;
  } | null = null;

  await withSurfacesApi(
    fakeSurfaceService({
      moveSurfaceOrder: (request) =>
        Effect.sync(() => {
          input = request;
          return { worktreeId: request.worktreeId, surfaceId: request.surfaceId };
        }),
    }),
    async (fastify) => {
      const response = await fastify.inject({
        method: 'PUT',
        url: '/api/v1/worktrees/10/surfaces/42/order',
        payload: { beforeSurfaceId: 43 },
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(input, { worktreeId: 10, surfaceId: 42, beforeSurfaceId: 43 });
    },
  );
});

test('surface order route rejects a body that omits the anchor field', async () => {
  await withSurfacesApi(fakeSurfaceService(), async (fastify) => {
    const response = await fastify.inject({
      method: 'PUT',
      url: '/api/v1/worktrees/10/surfaces/42/order',
      payload: {},
    });
    const payload = response.json() as { error?: { readonly code?: string } };

    assert.equal(response.statusCode, 400);
    assert.equal(payload.error?.code, 'api_request_decoding_failed');
  });
});

test('surface order route reports a cross-worktree surface rather than adopting it', async () => {
  await withSurfacesApi(
    fakeSurfaceService({
      moveSurfaceOrder: (request) =>
        Effect.fail(
          new SurfaceOrderError({
            reason: 'surface_worktree_mismatch',
            message: 'That surface belongs to a different worktree.',
            worktreeId: request.worktreeId,
            surfaceId: request.surfaceId,
          }),
        ),
    }),
    async (fastify) => {
      const response = await fastify.inject({
        method: 'PUT',
        url: '/api/v1/worktrees/10/surfaces/42/order',
        payload: { beforeSurfaceId: null },
      });
      const payload = response.json() as {
        error?: { readonly code?: string; readonly data?: unknown; readonly requestId?: unknown };
      };

      assert.equal(response.statusCode, 400);
      assert.equal(payload.error?.code, 'surface_order_rejected');
      assert.equal(typeof payload.error?.requestId, 'string');
      assert.deepEqual(payload.error?.data, {
        reason: 'surface_worktree_mismatch',
        worktreeId: 10,
        surfaceId: 42,
      });
    },
  );
});

test('surface order route reports a cross-worktree anchor with the anchor identifier', async () => {
  await withSurfacesApi(
    fakeSurfaceService({
      moveSurfaceOrder: (request) =>
        Effect.fail(
          new SurfaceOrderError({
            reason: 'before_surface_worktree_mismatch',
            message: 'The insertion anchor belongs to a different worktree.',
            worktreeId: request.worktreeId,
            surfaceId: request.surfaceId,
            ...(request.beforeSurfaceId === null
              ? {}
              : { beforeSurfaceId: request.beforeSurfaceId }),
          }),
        ),
    }),
    async (fastify) => {
      const response = await fastify.inject({
        method: 'PUT',
        url: '/api/v1/worktrees/10/surfaces/42/order',
        payload: { beforeSurfaceId: 77 },
      });
      const payload = response.json() as {
        error?: { readonly code?: string; readonly data?: unknown };
      };

      assert.equal(response.statusCode, 400);
      assert.equal(payload.error?.code, 'surface_order_rejected');
      assert.deepEqual(payload.error?.data, {
        reason: 'before_surface_worktree_mismatch',
        worktreeId: 10,
        surfaceId: 42,
        beforeSurfaceId: 77,
      });
    },
  );
});

async function withSurfacesApi<A>(
  service: SurfaceServiceShape,
  run: (fastify: Fastify.FastifyInstance) => Promise<A>,
) {
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(Layer.succeed(SurfaceService, service));
  try {
    registerSurfacesApi(fastify, runtime as never);
    await fastify.ready();
    return await run(fastify);
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
}

function fakeSurfaceService(overrides: Partial<SurfaceServiceShape> = {}): SurfaceServiceShape {
  return {
    getSurfaceDetail: () => Effect.succeed(surfaceDetail),
    openEditor: () => Effect.die('openEditor is not used by surfaces API tests'),
    renameSurface: (input) => Effect.succeed({ surfaceId: input.surfaceId, title: input.title }),
    deleteSurface: (surfaceId) =>
      Effect.succeed({
        deletedSurfaceId: surfaceId,
        deletedPaneIds: [],
      }),
    deleteSurfacePane: (input) =>
      Effect.succeed({
        deletedSurfaceId: null,
        deletedPaneIds: [input.paneId],
      }),
    createSurface: (input) =>
      Effect.succeed({
        worktreeId: input.worktreeId,
        surfaceId: 42,
        paneId: 7,
        title:
          input.initialPane.kind === 'agent_session' && input.initialPane.harness === 'opencode'
            ? 'OpenCode'
            : 'Terminal',
      }),
    splitPane: (input) =>
      Effect.succeed({
        worktreeId: input.worktreeId,
        surfaceId: 42,
        paneId: 8,
        title: input.split.newPane.kind === 'agent_session' ? 'Pi 2' : 'Terminal 2',
      }),
    setSplitWeights: (input) =>
      Effect.succeed({
        surfaceId: input.surfaceId,
        layout: {
          kind: 'split',
          nodeId: input.weights.nodeId,
          axis: 'row',
          sizing: 'manual',
          children: [
            { kind: 'leaf', nodeId: 'pane-7', paneId: 7, collapsed: false },
            { kind: 'leaf', nodeId: 'pane-8', paneId: 8, collapsed: false },
          ],
          weights: input.weights.weights,
        },
      }),
    createPaneSession: (input) =>
      Effect.succeed({
        worktreeId: input.worktreeId,
        surfaceId: 42,
        paneId: input.create.paneId,
        attachToken: 'test-attach-token',
        session:
          input.create.kind === 'terminal_session'
            ? { kind: 'terminal_session', terminalSessionId: 1 }
            : { kind: 'agent_session', agentSessionId: 1 },
      }),
    claimPaneSession: (input) =>
      Effect.succeed({
        worktreeId: input.worktreeId,
        surfaceId: 42,
        paneId: input.claim.paneId,
        attachToken: 'test-attach-token',
        session:
          input.claim.action === 'claim_terminal_session'
            ? { kind: 'terminal_session', terminalSessionId: input.claim.terminalSessionId }
            : { kind: 'agent_session', agentSessionId: input.claim.agentSessionId },
      }),
    createSinglePaneSurface: () =>
      Effect.die('createSinglePaneSurface is not used by surface API tests'),
    setWorktreeEnvironmentFocus: (input) =>
      Effect.succeed({
        worktreeId: input.worktreeId,
        activeSurfaceId: input.focus.activeSurfaceId,
        activePaneId: input.focus.activePaneId,
      }),
    moveSurfaceOrder: (input) =>
      Effect.succeed({ worktreeId: input.worktreeId, surfaceId: input.surfaceId }),
    ...overrides,
  };
}

const surfaceDetail = {
  id: 42,
  worktreeId: 10,
  title: 'Terminal',
  layout: {
    kind: 'leaf',
    nodeId: 'pane-7',
    paneId: 7,
    collapsed: false,
  },
  activePaneId: 7,
  panes: [
    {
      id: 7,
      surfaceId: 42,
      title: 'Terminal',
      sortOrder: 0,
      session: null,
    },
  ],
} satisfies SurfaceDetail;
