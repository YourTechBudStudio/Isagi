import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Cause } from 'effect';
import { AsyncResult } from 'effect/reactivity';

import { mutationData, mutationError, queryError } from './result.js';

const failure = new Error('refused');
const failed = AsyncResult.failure<number, Error>(Cause.fail(failure));

test('a query error shows for any failure, also while a refetch runs', () => {
  assert.equal(queryError(failed), failure);
  assert.equal(queryError(AsyncResult.waiting(failed)), failure);
  assert.equal(queryError(AsyncResult.success(1)), null);
  assert.equal(queryError(AsyncResult.initial(true)), null);
});

test('a mutation error and data show only once settled; a rerun hides the previous outcome', () => {
  assert.equal(mutationError(failed), failure);
  assert.equal(mutationError(AsyncResult.waiting(failed)), null, 'rerun after a failure');
  assert.equal(mutationData(AsyncResult.success(1)), 1);
  assert.equal(mutationData(AsyncResult.waiting(AsyncResult.success(1))), undefined);
  assert.equal(mutationData(failed), undefined);
});
