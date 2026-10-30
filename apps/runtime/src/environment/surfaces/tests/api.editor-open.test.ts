import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer, ManagedRuntime } from 'effect';
import Fastify, { type FastifyInstance } from 'fastify';

import type { OpenEditorOutput } from '@isagi/contracts';

import { EditorUnavailable } from '../../../editor/index.js';
import { DatabaseError } from '../../../platform/persistence/index.js';
import { SurfaceError, SurfaceService } from '../../index.js';
import { registerSurfacesApi } from '../api.js';

/**
 * `editor.open` is a placement, so the surface routes register it; its failures still answer in
 * the editor's error vocabulary. Every case goes through a real `fastify.inject`, because a mapper
 * branch with no member in the endpoint's declared error union is delivered to the client as
 * `api_response_encoding_failed`, which only the real route path shows.
 */
function fakeSurfaces(overrides: Partial<SurfaceService['Service']>): SurfaceService['Service'] {
  return new Proxy(
    { openEditor: () => Effect.die('openEditor is not used by this test'), ...overrides },
    {
      get: (target, property) =>
        property in target
          ? target[property as keyof typeof target]
          : () => Effect.die(`${String(property)} is not used by editor.open API tests`),
    },
  ) as SurfaceService['Service'];
}

async function withEditorOpenApi(
  use: (fastify: FastifyInstance) => Promise<void>,
  surfaces: Partial<SurfaceService['Service']>,
) {
  const runtime = ManagedRuntime.make(Layer.succeed(SurfaceService, fakeSurfaces(surfaces)));
  const fastify = Fastify({ logger: false });
  registerSurfacesApi(fastify, runtime as never);
  try {
    await fastify.ready();
    await use(fastify);
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
}

async function editorOpenErrorResponse(
  request: { readonly method: 'POST'; readonly url: string; readonly body?: unknown },
  surfaces: Partial<SurfaceService['Service']>,
) {
  let captured: { statusCode: number; code: string; data: Record<string, unknown> } | null = null;
  await withEditorOpenApi(async (fastify) => {
    const response = await fastify.inject({
      method: request.method,
      url: request.url,
      ...(request.body === undefined ? {} : { payload: request.body as object }),
    });
    const payload = response.json() as {
      error?: { code: string; data: Record<string, unknown> };
    };
    captured = {
      statusCode: response.statusCode,
      code: payload.error?.code ?? 'missing',
      data: payload.error?.data ?? {},
    };
  }, surfaces);
  assert.ok(captured);
  return captured as unknown as {
    statusCode: number;
    code: string;
    data: Record<string, unknown>;
  };
}

test('the open route returns the placement the operation resolved', async () => {
  await withEditorOpenApi(
    async (fastify) => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/worktrees/4/editor',
        payload: { intoSurfaceId: 11 },
      });
      const payload = response.json() as { data?: OpenEditorOutput };

      assert.equal(response.statusCode, 200);
      // Placement is the operation's whole answer, which is why opening an
      // editor adds no separate "which surface holds it?" read.
      assert.deepEqual(payload.data, {
        worktreeId: 4,
        surfaceId: 11,
        paneId: 23,
        editorContextId: 5,
      });
    },
    {
      openEditor: ({ worktreeId, intoSurfaceId }) =>
        Effect.succeed({
          worktreeId,
          surfaceId: intoSurfaceId ?? 99,
          paneId: 23,
          editorContextId: 5,
        }),
    },
  );
});

test('EditorUnavailable maps to a 400 rejection carrying its reason and diagnostic', async () => {
  const response = await editorOpenErrorResponse(
    { method: 'POST', url: '/api/v1/worktrees/4/editor', body: { intoSurfaceId: null } },
    {
      openEditor: () =>
        Effect.fail(
          new EditorUnavailable({
            reason: 'editor_unavailable',
            diagnostic: 'Code Server is still provisioning.',
          }),
        ),
    },
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.code, 'editor_rejected');
  assert.equal(response.data.reason, 'editor_unavailable');
  assert.equal(response.data.diagnostic, 'Code Server is still provisioning.');
});

test('a surfaces worktree_not_found is translated into the editor rejection vocabulary', async () => {
  const response = await editorOpenErrorResponse(
    { method: 'POST', url: '/api/v1/worktrees/4/editor', body: { intoSurfaceId: null } },
    {
      openEditor: () =>
        Effect.fail(
          new SurfaceError({
            code: 'worktree_not_found',
            message: 'Worktree 4 was not found.',
            worktreeId: 4,
          }),
        ),
    },
  );

  // Translated rather than delegated, because the editor's own refusal
  // vocabulary already names it and the palette reads one reason set.
  assert.equal(response.statusCode, 400);
  assert.equal(response.code, 'editor_rejected');
  assert.equal(response.data.reason, 'worktree_not_found');
  assert.equal(response.data.worktreeId, 4);
});

test('any other SurfaceError is delegated rather than given an invented editor reason', async () => {
  const response = await editorOpenErrorResponse(
    { method: 'POST', url: '/api/v1/worktrees/4/editor', body: { intoSurfaceId: null } },
    {
      openEditor: () =>
        Effect.fail(
          new SurfaceError({
            code: 'surface_not_found',
            message: 'Surface 11 was not found.',
            surfaceId: 11,
          }),
        ),
    },
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.code, 'surface_rejected');
});

test('a database fault reaches the client as runtime_database_failed, not an encoding failure', async () => {
  const response = await editorOpenErrorResponse(
    { method: 'POST', url: '/api/v1/worktrees/4/editor', body: { intoSurfaceId: null } },
    {
      openEditor: () =>
        Effect.fail(
          new DatabaseError({ operation: 'create_single_pane_surface', cause: 'disk full' }),
        ),
    },
  );

  // An earlier revision of the contract omitted this member, which would have
  // turned a diagnosable database fault into an undiagnosable encoding failure.
  assert.equal(response.statusCode, 500);
  assert.equal(response.code, 'runtime_database_failed');
  assert.equal(response.data.operation, 'create_single_pane_surface');
});
