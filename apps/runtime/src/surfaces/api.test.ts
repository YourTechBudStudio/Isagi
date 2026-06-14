import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer, ManagedRuntime } from 'effect';
import Fastify from 'fastify';

import type { DeleteSurfaceOutput, RenameSurfaceOutput, SurfaceDetail } from '@isagi/contracts';

import { registerSurfacesApi } from './api.js';
import { SurfaceError, SurfaceService, type SurfaceServiceShape } from './index.js';

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
          attemptedPtySessionIds: [70],
          warnings: [
            {
              code: 'pty_backend_unavailable',
              paneId: 7,
              ptySessionId: 70,
            },
          ],
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
        attemptedPtySessionIds: [70],
        warnings: [
          {
            code: 'pty_backend_unavailable',
            paneId: 7,
            ptySessionId: 70,
          },
        ],
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
            attemptedPtySessionIds: [],
            warnings: [],
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
        attemptedPtySessionIds: [],
        warnings: [],
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
    renameSurface: (input) => Effect.succeed({ surfaceId: input.surfaceId, title: input.title }),
    deleteSurface: (surfaceId) =>
      Effect.succeed({
        deletedSurfaceId: surfaceId,
        deletedPaneIds: [],
        attemptedPtySessionIds: [],
        warnings: [],
      }),
    deleteSurfacePane: (input) =>
      Effect.succeed({
        deletedSurfaceId: null,
        deletedPaneIds: [input.paneId],
        attemptedPtySessionIds: [],
        warnings: [],
      }),
    cleanupWorktreeForDelete: () => Effect.succeed({ attemptedPtySessionIds: [], warnings: [] }),
    createSinglePaneSurface: () =>
      Effect.die('createSinglePaneSurface is not used by surface API tests'),
    setWorktreeEnvironmentFocus: (input) =>
      Effect.succeed({
        worktreeId: input.worktreeId,
        activeSurfaceId: input.focus.activeSurfaceId,
        activePaneId: input.focus.activePaneId,
      }),
    ...overrides,
  };
}

const surfaceDetail = {
  id: 42,
  worktreeId: 10,
  kind: 'terminal',
  title: 'Terminal',
  attention: 'idle',
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
      attention: 'idle',
      sortOrder: 0,
      ptySession: null,
    },
  ],
} satisfies SurfaceDetail;
