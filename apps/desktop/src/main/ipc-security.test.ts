import assert from 'node:assert/strict';
import test from 'node:test';

import { assertAuthorizedIpcSender } from './ipc-security.js';

test('IPC authorization accepts only the active non-destroyed Isagi window', () => {
  const activeContents = {};
  const activeWindow = {
    isDestroyed: () => false,
    webContents: activeContents,
  };
  assert.doesNotThrow(() =>
    assertAuthorizedIpcSender(activeWindow as never, { sender: activeContents } as never),
  );
  assert.throws(
    () => assertAuthorizedIpcSender(activeWindow as never, { sender: {} } as never),
    /active Isagi window/,
  );
  assert.throws(
    () =>
      assertAuthorizedIpcSender(
        { ...activeWindow, isDestroyed: () => true } as never,
        { sender: activeContents } as never,
      ),
    /active Isagi window/,
  );
  assert.throws(
    () => assertAuthorizedIpcSender(undefined, { sender: activeContents } as never),
    /active Isagi window/,
  );
});
