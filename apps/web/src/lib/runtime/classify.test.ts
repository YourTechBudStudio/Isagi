import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import type { ApiError } from '@isagi/contracts';

import { classifyRuntimeFailure } from './classify.js';
import { RuntimeApiError, RuntimeDecodeError, RuntimeTransportError } from './errors.js';

const apiError = {
  code: 'runtime_database_failed',
  status: 500,
  message: 'boom',
  requestId: 'req-db',
  data: { operation: 'read' },
} satisfies ApiError;

test('classifies a direct RuntimeApiError and carries its structured apiError', () => {
  const result = classifyRuntimeFailure(new RuntimeApiError(apiError));
  assert.equal(result.kind, 'api');
  assert.equal(result.kind === 'api' && result.apiError.code, 'runtime_database_failed');
});

test('unwraps an Effect fiber-failure before classifying', async () => {
  const wrapped = await Effect.runPromise(Effect.fail(new RuntimeApiError(apiError))).catch(
    (cause: unknown) => cause,
  );
  const result = classifyRuntimeFailure(wrapped);
  assert.equal(result.kind, 'api');
  assert.equal(result.kind === 'api' && result.apiError.requestId, 'req-db');
});

test('classifies transport failures', () => {
  assert.equal(classifyRuntimeFailure(new RuntimeTransportError('nope', null)).kind, 'transport');
});

test('classifies decode failures and captures the endpoint id', () => {
  const result = classifyRuntimeFailure(new RuntimeDecodeError('workflows.descriptors', null));
  assert.equal(result.kind, 'decode');
  assert.equal(result.kind === 'decode' && result.endpointId, 'workflows.descriptors');
});

test('classifies anything else as unknown', () => {
  assert.equal(classifyRuntimeFailure(new Error('defect')).kind, 'unknown');
  assert.equal(classifyRuntimeFailure(undefined).kind, 'unknown');
});
