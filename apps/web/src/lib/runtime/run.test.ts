import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import type { ApiError } from '@isagi/contracts';
import { RuntimeApiError } from '@isagi/runtime-client';

import { runRuntimeEffect } from './run.js';

const pathRejectedError = new RuntimeApiError({
  endpointId: 'projects.add',
  apiError: {
    code: 'project_path_rejected',
    status: 400,
    message: 'Not a Git repository: /repo/nope',
    requestId: 'req-path-rejected',
    data: { reason: 'not_git_repository', path: '/repo/nope' },
  } satisfies ApiError,
});

test('runRuntimeEffect rejects with the typed Effect failure', async () => {
  await assert.rejects(
    () => runRuntimeEffect(Effect.fail(pathRejectedError)),
    (error) => error === pathRejectedError,
  );
});

test('runRuntimeEffect rejects with the defect when the effect dies', async () => {
  const defect = new Error('defect');
  await assert.rejects(
    () => runRuntimeEffect(Effect.die(defect)),
    (error) => error === defect,
  );
});

test('Effect.runPromise rejects with the typed failure itself, with no wrapper to unwrap', async () => {
  const rejection = await Effect.runPromise(Effect.fail(pathRejectedError)).catch(
    (error: unknown) => error,
  );

  assert.equal(rejection, pathRejectedError);
});
