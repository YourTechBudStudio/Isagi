import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer, ManagedRuntime } from 'effect';
import Fastify, { type FastifyInstance } from 'fastify';

import type {
  EditorContextFacts,
  EditorDiagnosticsOutput,
  OpenEditorOutput,
  RetryEditorProvisioningOutput,
} from '@isagi/contracts';

import {
  EditorContextService,
  EditorDiagnosticsUnavailable,
  EditorError,
  EditorLaunchFailed,
  type EditorContextServiceShape,
} from '../editor-contexts/index.js';
import {
  EditorProvisioning,
  EditorProvisioningBusy,
  EditorUnavailable,
  type EditorProvisioningService,
} from '../editor-provisioning/index.js';
import { DatabaseError } from '../persistence/index.js';
import { SurfaceError, SurfaceService, type SurfaceServiceShape } from '../surfaces/index.js';
import { registerEditorApi } from './api.js';

function fakeProvisioning(
  overrides: Partial<EditorProvisioningService>,
): EditorProvisioningService {
  return {
    start: Effect.void,
    state: Effect.succeed({ status: 'not_applicable' }),
    retry: Effect.succeed({ status: 'not_applicable' }),
    requireReady: Effect.fail(
      new EditorUnavailable({ reason: 'editor_unsupported_runtime', diagnostic: null }),
    ),
    ...overrides,
  };
}

function fakeEditors(overrides: Partial<EditorContextServiceShape>): EditorContextServiceShape {
  return {
    requireAvailable: Effect.die('requireAvailable is not used by editor API tests'),
    findForWorktree: () => Effect.die('findForWorktree is not used by editor API tests'),
    createForWorktree: () => Effect.die('createForWorktree is not used by editor API tests'),
    ensureRuntime: () => Effect.die('ensureRuntime is not used by this test'),
    releaseIncarnation: () => Effect.die('releaseIncarnation is not used by editor API tests'),
    readinessFor: () => Effect.die('readinessFor is not used by editor API tests'),
    diagnostics: () => Effect.die('diagnostics is not used by this test'),
    ...overrides,
  };
}

function fakeSurfaces(overrides: Partial<SurfaceServiceShape>): SurfaceServiceShape {
  return new Proxy(
    { openEditor: () => Effect.die('openEditor is not used by this test'), ...overrides },
    {
      get: (target, property) =>
        property in target
          ? target[property as keyof typeof target]
          : () => Effect.die(`${String(property)} is not used by editor API tests`),
    },
  ) as SurfaceServiceShape;
}

async function withEditorApi(
  service: EditorProvisioningService,
  use: (fastify: FastifyInstance) => Promise<void>,
  services: {
    readonly editors?: Partial<EditorContextServiceShape> | undefined;
    readonly surfaces?: Partial<SurfaceServiceShape> | undefined;
  } = {},
) {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(EditorProvisioning, service),
      Layer.succeed(EditorContextService, fakeEditors(services.editors ?? {})),
      Layer.succeed(SurfaceService, fakeSurfaces(services.surfaces ?? {})),
    ),
  );
  const fastify = Fastify({ logger: false });
  // Registered exactly the way `server.ts` registers it, so this proves the
  // route really is reachable rather than that a handler function exists.
  registerEditorApi(fastify, runtime as never);
  try {
    await fastify.ready();
    await use(fastify);
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
}

/**
 * Every failure branch is asserted through a real `fastify.inject`, never
 * against the mapper in isolation.
 *
 * `sendRouteApiError` validates every error whose code does not begin with
 * `api_` against the endpoint's declared error schema, and a miss is delivered
 * to the client as `api_response_encoding_failed` rather than as the failure
 * that actually happened. A mapper branch with no member in the contract union
 * would therefore pass a unit test and fail in production, which is exactly the
 * bug these cases exist to catch.
 */
async function editorErrorResponse(
  request: { readonly method: 'POST' | 'GET'; readonly url: string; readonly body?: unknown },
  services: {
    readonly editors?: Partial<EditorContextServiceShape> | undefined;
    readonly surfaces?: Partial<SurfaceServiceShape> | undefined;
  },
) {
  let captured: { statusCode: number; code: string; data: Record<string, unknown> } | null = null;
  await withEditorApi(
    fakeProvisioning({}),
    async (fastify) => {
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
    },
    services,
  );
  assert.ok(captured);
  return captured as unknown as {
    statusCode: number;
    code: string;
    data: Record<string, unknown>;
  };
}

test('the retry route returns the settled provisioning state', async () => {
  await withEditorApi(
    fakeProvisioning({ retry: Effect.succeed({ status: 'ready', version: '4.135.0' }) }),
    async (fastify) => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/editor/provisioning/retry',
      });
      const payload = response.json() as { data?: RetryEditorProvisioningOutput };

      assert.equal(response.statusCode, 200);
      assert.deepEqual(payload.data, { provisioning: { status: 'ready', version: '4.135.0' } });
    },
  );
});

test('retry on a runtime that declares no editor capability succeeds with not_applicable', async () => {
  // Deliberately not an error. Retry asks the provisioning domain to report or
  // re-enter its state, and `not_applicable` is the complete answer to that
  // question; only operations that need an installation refuse.
  await withEditorApi(fakeProvisioning({}), async (fastify) => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/editor/provisioning/retry',
    });
    const payload = response.json() as { data?: RetryEditorProvisioningOutput };

    assert.equal(response.statusCode, 200);
    assert.deepEqual(payload.data, { provisioning: { status: 'not_applicable' } });
  });
});

test('a retry arriving while one is running maps to editor_rejected', async () => {
  await withEditorApi(
    fakeProvisioning({ retry: Effect.fail(new EditorProvisioningBusy()) }),
    async (fastify) => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/editor/provisioning/retry',
      });
      const payload = response.json() as {
        error?: { code: string; data: { reason: string } };
      };

      assert.equal(response.statusCode, 400);
      assert.equal(payload.error?.code, 'editor_rejected');
      // The reason is a member of the contract's rejection union, so the client
      // can branch on it rather than on a message.
      assert.equal(payload.error?.data.reason, 'editor_provisioning_busy');
    },
  );
});

test('an unexpected failure is reported as an unhandled API error, not as a rejection', async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await withEditorApi(
      fakeProvisioning({ retry: Effect.fail(new Error('boom')) as never }),
      async (fastify) => {
        const response = await fastify.inject({
          method: 'POST',
          url: '/api/v1/editor/provisioning/retry',
        });
        const payload = response.json() as { error?: { code: string } };

        assert.equal(response.statusCode, 500);
        // `api_`-prefixed codes bypass the endpoint's declared error schema, so
        // the fallback is safe even though this code is not in the editor union.
        assert.equal(payload.error?.code, 'api_unhandled_error');
      },
    );
  } finally {
    console.error = originalConsoleError;
  }
});

// ---------------------------------------------------------------------------
// The three routes registered alongside retry, and total error mapping
// ---------------------------------------------------------------------------

test('the open route returns the placement the operation resolved', async () => {
  await withEditorApi(
    fakeProvisioning({}),
    async (fastify) => {
      const response = await fastify.inject({ method: 'POST', url: '/api/v1/worktrees/4/editor' });
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
      surfaces: {
        openEditor: ({ worktreeId }) =>
          Effect.succeed({ worktreeId, surfaceId: 11, paneId: 23, editorContextId: 5 }),
      },
    },
  );
});

test('the ensure route decodes its intent and returns the editor context facts', async () => {
  let seen: { editorContextId: number; intent: string } | null = null;
  await withEditorApi(
    fakeProvisioning({}),
    async (fastify) => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/editor-contexts/5/runtime',
        payload: { intent: 'replace' },
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(seen, { editorContextId: 5, intent: 'replace' });
    },
    {
      editors: {
        ensureRuntime: (input) =>
          Effect.sync(() => {
            seen = input;
            return editorContextFacts;
          }),
      },
    },
  );
});

test('the diagnostics route decodes params and query together', async () => {
  let seen: { editorContextId: number; ptyProcessId: number } | null = null;
  await withEditorApi(
    fakeProvisioning({}),
    async (fastify) => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/api/v1/editor-contexts/5/diagnostics?ptyProcessId=88',
      });
      const payload = response.json() as { data?: EditorDiagnosticsOutput };

      assert.equal(response.statusCode, 200);
      // The only editor route with both, and the pair is load-bearing: a read
      // keyed only by context could return one incarnation's output to a pane
      // asking about another.
      assert.deepEqual(seen, { editorContextId: 5, ptyProcessId: 88 });
      assert.equal(payload.data?.ptyProcessId, 88);
    },
    {
      editors: {
        diagnostics: (input) =>
          Effect.sync(() => {
            seen = input;
            return {
              editorContextId: input.editorContextId,
              ptyProcessId: input.ptyProcessId,
              excerpt: 'listening on 127.0.0.1:41234',
              truncated: false,
              totalBytes: 28,
            };
          }),
      },
    },
  );
});

test('EditorUnavailable maps to a 400 rejection carrying its reason and diagnostic', async () => {
  const response = await editorErrorResponse(
    { method: 'POST', url: '/api/v1/worktrees/4/editor' },
    {
      surfaces: {
        openEditor: () =>
          Effect.fail(
            new EditorUnavailable({
              reason: 'editor_unsupported_runtime',
              diagnostic: 'this runtime declares no editor capability',
            }),
          ),
      },
    },
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.code, 'editor_rejected');
  assert.equal(response.data.reason, 'editor_unsupported_runtime');
  assert.equal(response.data.diagnostic, 'this runtime declares no editor capability');
});

test('a superseded diagnostics read maps to a 400 rejection carrying that reason', async () => {
  const response = await editorErrorResponse(
    { method: 'GET', url: '/api/v1/editor-contexts/5/diagnostics?ptyProcessId=88' },
    {
      editors: {
        diagnostics: () =>
          Effect.fail(
            new EditorError({
              code: 'editor_incarnation_superseded',
              message: 'PTY process 88 is no longer this context’s incarnation.',
              editorContextId: 5,
            }),
          ),
      },
    },
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.code, 'editor_rejected');
  assert.equal(response.data.reason, 'editor_incarnation_superseded');
  assert.equal(response.data.editorContextId, 5);
});

test('EditorLaunchFailed maps to a 409 carrying the same reason the row recorded', async () => {
  const response = await editorErrorResponse(
    { method: 'POST', url: '/api/v1/editor-contexts/5/runtime', body: { intent: 'reuse' } },
    {
      editors: {
        ensureRuntime: () =>
          Effect.fail(
            new EditorLaunchFailed({
              editorContextId: 5,
              reason: 'port_allocation_failed',
              detail: 'no free port in range',
            }),
          ),
      },
    },
  );

  // Not a 400: the request was well-formed and the target valid. The attempt ran
  // and failed, so the caller's correct response is to re-read the context.
  assert.equal(response.statusCode, 409);
  assert.equal(response.code, 'editor_launch_failed');
  assert.equal(response.data.reason, 'port_allocation_failed');
  assert.equal(response.data.editorContextId, 5);
  assert.equal(response.data.detail, 'no free port in range');
});

test('EditorDiagnosticsUnavailable maps to a 500 carrying its detail', async () => {
  const response = await editorErrorResponse(
    { method: 'GET', url: '/api/v1/editor-contexts/5/diagnostics?ptyProcessId=88' },
    {
      editors: {
        diagnostics: () =>
          Effect.fail(new EditorDiagnosticsUnavailable({ editorContextId: 5, detail: 'EACCES' })),
      },
    },
  );

  // Deliberately not folded into a successful empty excerpt: "there is nothing
  // to show" and "we could not look" are different answers, and only one of them
  // is worth a retry.
  assert.equal(response.statusCode, 500);
  assert.equal(response.code, 'editor_diagnostics_unavailable');
  assert.equal(response.data.detail, 'EACCES');
});

test('a surfaces worktree_not_found is translated into the editor rejection vocabulary', async () => {
  const response = await editorErrorResponse(
    { method: 'POST', url: '/api/v1/worktrees/4/editor' },
    {
      surfaces: {
        openEditor: () =>
          Effect.fail(
            new SurfaceError({
              code: 'worktree_not_found',
              message: 'Worktree 4 was not found.',
              worktreeId: 4,
            }),
          ),
      },
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
  const response = await editorErrorResponse(
    { method: 'POST', url: '/api/v1/worktrees/4/editor' },
    {
      surfaces: {
        openEditor: () =>
          Effect.fail(
            new SurfaceError({
              code: 'surface_not_found',
              message: 'Surface 11 was not found.',
              surfaceId: 11,
            }),
          ),
      },
    },
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.code, 'surface_rejected');
});

test('a database fault reaches the client as runtime_database_failed, not an encoding failure', async () => {
  const response = await editorErrorResponse(
    { method: 'POST', url: '/api/v1/worktrees/4/editor' },
    {
      surfaces: {
        openEditor: () =>
          Effect.fail(
            new DatabaseError({ operation: 'create_single_pane_surface', cause: 'disk full' }),
          ),
      },
    },
  );

  // An earlier revision of the contract omitted this member, which would have
  // turned a diagnosable database fault into an undiagnosable encoding failure.
  assert.equal(response.statusCode, 500);
  assert.equal(response.code, 'runtime_database_failed');
  assert.equal(response.data.operation, 'create_single_pane_surface');
});

const editorContextFacts: EditorContextFacts = {
  id: 5,
  worktreeId: 4,
  activePtyProcessId: 88,
  attempt: { state: 'none' },
  processStatus: 'running',
  processDiagnostic: null,
  processDiagnosticDetail: null,
  workbenchReadiness: 'ready',
  readinessDetail: null,
  endpoint: { host: '127.0.0.1', port: 41_234, url: 'http://127.0.0.1:41234' },
  hasDiagnostics: true,
  createdAt: '2026-06-15T00:00:00.000Z',
  updatedAt: '2026-06-15T00:00:00.000Z',
};
