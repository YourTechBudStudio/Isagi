import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import type { ApiError } from '@isagi/contracts';

import { RuntimeApiError } from './client.js';
import { runRuntimeEffect, unwrapRuntimeFailure } from './run.js';

const pathRejectedError = new RuntimeApiError({
  code: 'project_path_rejected',
  status: 400,
  message: 'Not a Git repository: /repo/nope',
  requestId: 'req-path-rejected',
  data: { reason: 'not_git_repository', path: '/repo/nope' },
} satisfies ApiError);

test('runRuntimeEffect rejects with the typed Effect failure', async () => {
  await assert.rejects(
    () => runRuntimeEffect(Effect.fail(pathRejectedError)),
    (error) => error === pathRejectedError,
  );
});

test('unwrapRuntimeFailure extracts the typed failure from an Effect FiberFailure', async () => {
  const wrapped = await Effect.runPromise(Effect.fail(pathRejectedError)).catch(
    (error: unknown) => error,
  );

  assert.equal(unwrapRuntimeFailure(wrapped), pathRejectedError);
});
