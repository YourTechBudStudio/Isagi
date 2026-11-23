import assert from 'node:assert/strict';
import test from 'node:test';

import { destroyRendererForExit } from './runtime-ipc.js';

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
