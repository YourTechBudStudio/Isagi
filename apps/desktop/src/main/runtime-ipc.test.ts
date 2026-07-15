import assert from 'node:assert/strict';
import test from 'node:test';

import { destroyRendererForExit, resolveRuntimeUrlForIpc } from './runtime-ipc.js';

test('runtime URL IPC preserves operational success and failure', async () => {
  assert.equal(
    await resolveRuntimeUrlForIpc(
      () => Promise.resolve('http://127.0.0.1:1'),
      () => false,
    ),
    'http://127.0.0.1:1',
  );
  await assert.rejects(
    resolveRuntimeUrlForIpc(
      () => Promise.reject(new Error('unavailable')),
      () => false,
    ),
    /unavailable/,
  );
});

test('runtime URL IPC stays pending when application exit overtakes the request', async () => {
  let exitRequested = false;
  let rejectRuntimeUrl!: (error: Error) => void;
  const result = resolveRuntimeUrlForIpc(
    () =>
      new Promise((_resolve, reject) => {
        rejectRuntimeUrl = reject;
      }),
    () => exitRequested,
  );
  exitRequested = true;
  rejectRuntimeUrl(new Error('Runtime lifecycle is stopping or stopped.'));

  const settled = await Promise.race([
    result.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 10)),
  ]);
  assert.equal(settled, false);
});

test('application exit destroys the active renderer once', () => {
  let destroyed = false;
  let destroyCalls = 0;
  const window = {
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      destroyCalls += 1;
    },
  };

  destroyRendererForExit(window);
  destroyRendererForExit(window);
  assert.equal(destroyCalls, 1);
});
