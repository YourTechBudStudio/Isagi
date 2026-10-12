import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import type { ApiError } from '@isagi/contracts';
import { RuntimeApiError, RuntimeDecodeError, RuntimeTransportError } from '@isagi/runtime-client';

import { classifyRuntimeFailure } from './classify.js';

const apiError = {
  code: 'runtime_database_failed',
  status: 500,
  message: 'boom',
  requestId: 'req-db',
  data: { operation: 'read' },
} satisfies ApiError;

test('classifies a direct RuntimeApiError and carries its structured apiError', () => {
  const result = classifyRuntimeFailure(
    new RuntimeApiError({ endpointId: 'workflows.start', apiError }),
  );
  assert.equal(result.kind, 'api');
  assert.equal(result.kind === 'api' && result.apiError.code, 'runtime_database_failed');
});

test('classifies the rejection of Effect.runPromise as-is', async () => {
  const rejection = await Effect.runPromise(
    Effect.fail(new RuntimeApiError({ endpointId: 'workflows.start', apiError })),
  ).catch((cause: unknown) => cause);
  const result = classifyRuntimeFailure(rejection);
  assert.equal(result.kind, 'api');
  assert.equal(result.kind === 'api' && result.apiError.requestId, 'req-db');
});

test('classifies transport failures', () => {
  assert.equal(
    classifyRuntimeFailure(new RuntimeTransportError({ endpointId: 'nope', cause: null })).kind,
    'transport',
  );
});

test('classifies decode failures and captures the endpoint id', () => {
  const result = classifyRuntimeFailure(
    new RuntimeDecodeError({ endpointId: 'workflows.descriptors', cause: null }),
  );
  assert.equal(result.kind, 'decode');
  assert.equal(result.kind === 'decode' && result.endpointId, 'workflows.descriptors');
});

test('classifies anything else as unknown', () => {
  assert.equal(classifyRuntimeFailure(new Error('defect')).kind, 'unknown');
  assert.equal(classifyRuntimeFailure(undefined).kind, 'unknown');
});
