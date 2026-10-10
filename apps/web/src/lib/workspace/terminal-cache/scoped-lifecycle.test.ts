import assert from 'node:assert/strict';
import test from 'node:test';

import { createScopedLifecycle } from './scoped-lifecycle.js';

test('finalizers run once, newest first, and a late one runs at once', () => {
  const ran: string[] = [];
  const lifecycle = createScopedLifecycle();
  lifecycle.addFinalizer(() => ran.push('a'));
  lifecycle.addFinalizer(() => ran.push('b'));

  lifecycle.dispose();
  lifecycle.dispose();
  assert.deepEqual(ran, ['b', 'a']);

  lifecycle.addFinalizer(() => ran.push('late'));
  assert.deepEqual(ran, ['b', 'a', 'late']);
});

test('a throwing finalizer does not stop the others; its error is rethrown after', () => {
  const ran: string[] = [];
  const lifecycle = createScopedLifecycle();
  lifecycle.addFinalizer(() => ran.push('a'));
  lifecycle.addFinalizer(() => {
    ran.push('b');
    throw new Error('boom');
  });
  lifecycle.addFinalizer(() => ran.push('c'));

  assert.throws(() => lifecycle.dispose(), /boom/);
  assert.deepEqual(ran, ['c', 'b', 'a']);
});
