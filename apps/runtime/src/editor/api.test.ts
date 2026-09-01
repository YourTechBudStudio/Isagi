import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer, ManagedRuntime } from 'effect';
import Fastify, { type FastifyInstance } from 'fastify';

import type { RetryEditorProvisioningOutput } from '@isagi/contracts';

import {
  EditorProvisioning,
  EditorProvisioningBusy,
  EditorUnavailable,
  type EditorProvisioningService,
} from '../editor-provisioning/index.js';
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

async function withEditorApi(
  service: EditorProvisioningService,
  use: (fastify: FastifyInstance) => Promise<void>,
) {
  const runtime = ManagedRuntime.make(Layer.succeed(EditorProvisioning, service));
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
