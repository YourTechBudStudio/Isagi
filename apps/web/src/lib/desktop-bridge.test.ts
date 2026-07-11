import assert from 'node:assert/strict';
import test from 'node:test';

import { canQuit, requestQuit } from './desktop-bridge.js';

const globalWithWindow = globalThis as { window?: unknown };

test('canQuit and requestQuit use the host bridge when it is present', () => {
  let quitCalls = 0;
  globalWithWindow.window = {
    isagi: {
      quitApp: () => {
        quitCalls += 1;
        return Promise.resolve();
      },
    },
  };
  try {
    assert.equal(canQuit(), true);
    requestQuit();
    assert.equal(quitCalls, 1);
  } finally {
    delete globalWithWindow.window;
  }
});

test('canQuit is false and requestQuit is a no-op without a host bridge', () => {
  globalWithWindow.window = {};
  try {
    assert.equal(canQuit(), false);
    assert.doesNotThrow(() => requestQuit());
  } finally {
    delete globalWithWindow.window;
  }
});
