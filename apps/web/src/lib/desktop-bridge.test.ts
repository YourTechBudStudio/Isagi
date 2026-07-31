import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canQuit,
  desktopUpdateActions,
  hasDesktopUpdateHost,
  requestQuit,
  subscribeDesktopUpdate,
  subscribeRuntimeStatus,
  type DesktopUpdateSnapshot,
  type HostRuntimeStatusSnapshot,
} from './desktop-bridge.js';

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

test('host actions are no-ops without a host bridge', () => {
  globalWithWindow.window = {};
  try {
    assert.equal(canQuit(), false);
    assert.doesNotThrow(() => requestQuit());
  } finally {
    delete globalWithWindow.window;
  }
});

test('the update host is only present when both of its capabilities are', () => {
  globalWithWindow.window = {};
  try {
    assert.equal(hasDesktopUpdateHost(), false, 'a hosted web build has no update host');

    // A half-present bridge is not a host. Reading a snapshot we can never see
    // change would strand the rail on whatever it first saw.
    globalWithWindow.window = { isagi: { getDesktopUpdate: () => Promise.resolve() } };
    assert.equal(hasDesktopUpdateHost(), false);

    globalWithWindow.window = {
      isagi: { getDesktopUpdate: () => Promise.resolve(), subscribeDesktopUpdate: () => () => {} },
    };
    assert.equal(hasDesktopUpdateHost(), true);
  } finally {
    delete globalWithWindow.window;
  }
});

test('update subscription filters protocol versions and returns host cleanup', () => {
  let hostListener!: (snapshot: DesktopUpdateSnapshot) => void;
  let cleanupCalls = 0;
  const received: DesktopUpdateSnapshot[] = [];
  globalWithWindow.window = {
    isagi: {
      subscribeDesktopUpdate: (listener: (snapshot: DesktopUpdateSnapshot) => void) => {
        hostListener = listener;
        return () => {
          cleanupCalls += 1;
        };
      },
    },
  };
  try {
    const cleanup = subscribeDesktopUpdate((snapshot) => received.push(snapshot));
    const ready = {
      protocolVersion: 1,
      revision: 2,
      installedVersion: '0.4.2',
      state: 'ready',
      targetVersion: '0.4.3',
    } as const satisfies DesktopUpdateSnapshot;
    hostListener(ready);
    hostListener({ ...ready, protocolVersion: 2 } as unknown as DesktopUpdateSnapshot);
    assert.deepEqual(received, [ready]);
    cleanup();
    assert.equal(cleanupCalls, 1);
  } finally {
    delete globalWithWindow.window;
  }
});

test('each update action invokes its own host capability and nothing else', async () => {
  const called: string[] = [];
  const capability = (name: string) => () => {
    called.push(name);
    return Promise.resolve();
  };
  globalWithWindow.window = {
    isagi: {
      checkForUpdates: capability('check'),
      requestUpdateRestart: capability('requestRestart'),
      confirmUpdateRestart: capability('confirmRestart'),
      cancelUpdateRestart: capability('cancelRestart'),
      openUpdateDownloadPage: capability('openDownloadPage'),
    },
  };
  try {
    for (const action of Object.values(desktopUpdateActions)) await action();
    assert.deepEqual(called, [
      'check',
      'requestRestart',
      'confirmRestart',
      'cancelRestart',
      'openDownloadPage',
    ]);
  } finally {
    delete globalWithWindow.window;
  }
});

test('a rejected or absent update action resolves rather than surfacing as a product state', async () => {
  // The desktop owns the snapshot. A failed intent either changed nothing or
  // will announce itself in the next snapshot; the renderer only stops waiting.
  globalWithWindow.window = {
    isagi: {
      requestUpdateRestart: () => Promise.reject(new Error('renderer destroyed')),
      confirmUpdateRestart: () => {
        throw new Error('bridge torn down');
      },
    },
  };
  try {
    await assert.doesNotReject(() => desktopUpdateActions.requestRestart());
    await assert.doesNotReject(() => desktopUpdateActions.confirmRestart());
    // A hosted build simply has no such capability.
    await assert.doesNotReject(() => desktopUpdateActions.check());
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
