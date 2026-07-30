import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { stopDesktopServices } from './shutdown.js';

test('shutdown stops the updater before the runtime and tolerates partial initialization', async () => {
  const order: string[] = [];
  const updater = {
    stop: () =>
      Effect.sync(() => {
        order.push('updater');
      }),
  };
  const runtime = {
    stop: () =>
      Effect.sync(() => {
        order.push('runtime');
      }),
  };
  await Effect.runPromise(stopDesktopServices(updater as never, runtime as never));
  assert.deepEqual(order, ['updater', 'runtime']);

  order.length = 0;
  await Effect.runPromise(stopDesktopServices(undefined, runtime as never));
  assert.deepEqual(order, ['runtime']);
});
