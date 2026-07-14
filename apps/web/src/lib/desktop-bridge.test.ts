import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canQuit,
  requestQuit,
  requestRelaunch,
  subscribeRuntimeStatus,
  type HostRuntimeStatusSnapshot,
} from './desktop-bridge.js';

const globalWithWindow = globalThis as { window?: unknown };

test('canQuit and requestQuit use the host bridge when it is present', () => {
  let quitCalls = 0;
  let relaunchCalls = 0;
  globalWithWindow.window = {
    isagi: {
      quitApp: () => {
        quitCalls += 1;
        return Promise.resolve();
      },
      relaunchApp: () => {
        relaunchCalls += 1;
        return Promise.resolve();
      },
    },
  };
  try {
    assert.equal(canQuit(), true);
    requestQuit();
    requestRelaunch();
    assert.equal(quitCalls, 1);
    assert.equal(relaunchCalls, 1);
  } finally {
    delete globalWithWindow.window;
  }
});

test('host actions are no-ops without a host bridge', () => {
  globalWithWindow.window = {};
  try {
    assert.equal(canQuit(), false);
    assert.doesNotThrow(() => requestQuit());
    assert.doesNotThrow(() => requestRelaunch());
  } finally {
    delete globalWithWindow.window;
  }
});

test('runtime status subscription filters protocol versions and returns host cleanup', () => {
  let hostListener!: (snapshot: HostRuntimeStatusSnapshot) => void;
  let cleanupCalls = 0;
  const received: HostRuntimeStatusSnapshot[] = [];
  globalWithWindow.window = {
    isagi: {
      subscribeRuntimeStatus: (listener: (snapshot: HostRuntimeStatusSnapshot) => void) => {
        hostListener = listener;
        return () => {
          cleanupCalls += 1;
        };
      },
    },
  };
  try {
    const cleanup = subscribeRuntimeStatus((snapshot) => received.push(snapshot));
    const ready = {
      protocolVersion: 1,
      revision: 1,
      ownership: 'managed',
      state: 'ready',
    } as const satisfies HostRuntimeStatusSnapshot;
    hostListener(ready);
    hostListener({ ...ready, protocolVersion: 2 } as unknown as HostRuntimeStatusSnapshot);
    assert.deepEqual(received, [ready]);
    cleanup();
    assert.equal(cleanupCalls, 1);
  } finally {
    delete globalWithWindow.window;
  }
});
