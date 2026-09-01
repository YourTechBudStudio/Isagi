import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertAuthorizedIpcSender } from './ipc-security.js';

const mainFrame = { name: 'main' };
const activeContents = { mainFrame };
const activeWindow = {
  isDestroyed: () => false,
  webContents: activeContents,
};

test('IPC authorization accepts only the active non-destroyed Isagi window', () => {
  assert.doesNotThrow(() =>
    assertAuthorizedIpcSender(
      activeWindow as never,
      {
        sender: activeContents,
        senderFrame: mainFrame,
      } as never,
    ),
  );
  assert.throws(
    () =>
      assertAuthorizedIpcSender(
        activeWindow as never,
        {
          sender: {},
          senderFrame: mainFrame,
        } as never,
      ),
    /active Isagi window/,
  );
  assert.throws(
    () =>
      assertAuthorizedIpcSender(
        { ...activeWindow, isDestroyed: () => true } as never,
        { sender: activeContents, senderFrame: mainFrame } as never,
      ),
    /active Isagi window/,
  );
  assert.throws(
    () =>
      assertAuthorizedIpcSender(undefined, {
        sender: activeContents,
        senderFrame: mainFrame,
      } as never),
    /active Isagi window/,
  );
});

/**
 * The renderer frames a Code Server workbench, so "came from our window" is no
 * longer the same claim as "came from our document".
 */
test('a subframe of the active window is rejected even though its webContents matches', () => {
  assert.throws(
    () =>
      assertAuthorizedIpcSender(
        activeWindow as never,
        {
          sender: activeContents,
          senderFrame: { name: 'embedded-workbench' },
        } as never,
      ),
    /main Isagi frame/,
  );
  // Electron types `senderFrame` as nullable; a sender that cannot prove its
  // frame has not proven the main frame.
  assert.throws(
    () =>
      assertAuthorizedIpcSender(
        activeWindow as never,
        {
          sender: activeContents,
          senderFrame: null,
        } as never,
      ),
    /main Isagi frame/,
  );
});

/**
 * The handlers themselves live in the Electron entry module, which cannot be
 * imported without an Electron app. Authorization is not optional on any of
 * them, so it is verified structurally: a new channel that forgets the check
 * fails here rather than shipping an unauthorized one.
 */
test('every renderer-invokable channel authorizes its sender first', async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');

  const handlers = [...source.matchAll(/ipcMain\.handle\(\s*'([^']+)'[\s\S]*?\n\}\);/gu)];
  assert.ok(handlers.length >= 6, `expected the known channels, found ${handlers.length}`);

  const channels = handlers.map(([, channel]) => channel ?? '');
  assert.deepEqual(
    channels.filter((channel) => channel.startsWith('isagi:desktop-update')).sort(),
    ['isagi:desktop-update', 'isagi:desktop-update-intent'],
  );

  for (const [body, channel] of handlers)
    assert.match(body, /assertAuthorizedIpcSender\(mainWindow, event\)/u, channel);
});

test('the renderer is never handed a general invoke, a channel name, or a destination', async () => {
  const source = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), '../preload/index.ts'),
    'utf8',
  );

  const exposed = source.slice(source.indexOf('exposeInMainWorld'));
  // Every intent method is zero-argument; only the two capabilities that must
  // carry data — a status listener and the chrome flag — take a parameter.
  for (const method of [
    'checkForUpdates',
    'requestUpdateRestart',
    'confirmUpdateRestart',
    'cancelUpdateRestart',
    'openUpdateDownloadPage',
  ])
    assert.match(exposed, new RegExp(`${method}: \\(\\) =>`, 'u'), method);

  assert.doesNotMatch(exposed, /invoke: |https?:\/\//u);
});
