import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import type { ApiError } from '@isagi/contracts';

import { runtimeErrorCopy } from '../../../copy/index.js';
import {
  RuntimeApiError,
  RuntimeDecodeError,
  RuntimeTransportError,
} from '../../runtime/client.js';
import {
  formatRuntimeError,
  formatRuntimeErrorSummary,
  UserVisibleError,
} from '../runtime-data.js';

test('runtime error summary maps project path rejections to user copy without diagnostics', () => {
  const error = new RuntimeApiError({
    code: 'project_path_rejected',
    status: 400,
    message: 'Not a Git repository: /repo/nope',
    requestId: 'req-path-rejected',
    data: { reason: 'not_git_repository', path: '/repo/nope' },
  } satisfies ApiError);

  assert.equal(formatRuntimeErrorSummary(error), "That folder isn't a Git repository.");
  assert.equal(
    formatRuntimeError(error),
    "That folder isn't a Git repository. (project_path_rejected · request req-path-rejected)",
  );
});

test('runtime error formatting unwraps Effect promise failures before mapping copy', async () => {
  const error = new RuntimeApiError({
    code: 'project_path_rejected',
    status: 400,
    message: 'Not a Git repository: /repo/nope',
    requestId: 'req-path-rejected',
    data: { reason: 'not_git_repository', path: '/repo/nope' },
  } satisfies ApiError);
  const wrapped = await Effect.runPromise(Effect.fail(error)).catch((cause: unknown) => cause);

  assert.equal(formatRuntimeErrorSummary(wrapped), "That folder isn't a Git repository.");
  assert.equal(
    formatRuntimeError(wrapped),
    "That folder isn't a Git repository. (project_path_rejected · request req-path-rejected)",
  );
});

test('UserVisibleError passes its message through unchanged, with and without diagnostics', () => {
  const error = new UserVisibleError('Surface title cannot be empty.');
  assert.equal(formatRuntimeErrorSummary(error), 'Surface title cannot be empty.');
  assert.equal(formatRuntimeError(error), 'Surface title cannot be empty.');
});

test('transport failures map to the transport copy without a diagnostic suffix', () => {
  const error = new RuntimeTransportError('unreachable', null);
  assert.equal(formatRuntimeErrorSummary(error), runtimeErrorCopy.transport);
  assert.equal(formatRuntimeError(error), runtimeErrorCopy.transport);
});

test('decode failures map to the decode copy', () => {
  const error = new RuntimeDecodeError('workspace.get', null);
  assert.equal(formatRuntimeErrorSummary(error), runtimeErrorCopy.decode);
  assert.equal(formatRuntimeError(error), runtimeErrorCopy.decode);
});

test('unclassified defects map to the unknown copy', () => {
  assert.equal(formatRuntimeErrorSummary(new Error('boom')), runtimeErrorCopy.unknown);
  assert.equal(formatRuntimeError(new Error('boom')), runtimeErrorCopy.unknown);
});
