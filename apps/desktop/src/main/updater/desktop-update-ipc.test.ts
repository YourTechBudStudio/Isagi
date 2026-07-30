import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { DESKTOP_UPDATE_PROTOCOL_VERSION, type DesktopUpdateIntent } from '@isagi/contracts';

import type { DesktopUpdaterService } from './coordinator.js';
import { decodeDesktopUpdateIntent, dispatchDesktopUpdateIntent } from './desktop-update-ipc.js';
import { RELEASE_DOWNLOAD_PAGE_URL } from './download-page.js';

function fakeService() {
  const calls: string[] = [];
  const record = (name: string) => {
    calls.push(name);
    return Effect.void;
  };
  const service: DesktopUpdaterService = {
    snapshot: {
      protocolVersion: DESKTOP_UPDATE_PROTOCOL_VERSION,
      revision: 0,
      installedVersion: '1.2.3',
      state: 'idle',
    },
    subscribe: () => () => undefined,
    start: () => record('start'),
    stop: () => record('stop'),
    checkForUpdates: () => record('checkForUpdates'),
    requestRestart: () => record('requestRestart'),
    confirmRestart: () => record('confirmRestart'),
    cancelRestart: () => record('cancelRestart'),
    quitAndInstall: () => calls.push('quitAndInstall'),
    recordInstallRejection: () => {
      calls.push('recordInstallRejection');
      return Promise.resolve();
    },
    beginDownloadPageAttempt: () => {
      calls.push('beginDownloadPageAttempt');
      return (outcome) => {
        calls.push(`report:${outcome}`);
        return Promise.resolve();
      };
    },
  };
  return { service, calls };
}

test('every intent reaches exactly one operation', async () => {
  const opened: string[] = [];
  for (const [intent, expected] of [
    [{ type: 'check_for_updates' }, 'checkForUpdates'],
    [{ type: 'request_restart' }, 'requestRestart'],
    [{ type: 'confirm_restart' }, 'confirmRestart'],
    [{ type: 'cancel_restart' }, 'cancelRestart'],
  ] as const satisfies readonly (readonly [DesktopUpdateIntent, string])[]) {
    const { service, calls } = fakeService();
    await dispatchDesktopUpdateIntent(intent, {
      service,
      openExternal: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
    });
    assert.deepEqual(calls, [expected]);
  }
  assert.deepEqual(opened, [], 'no update operation may open a browser');
});

test('the download page is opened by main at a fixed destination, not by the updater', async () => {
  const { service, calls } = fakeService();
  const opened: string[] = [];

  await dispatchDesktopUpdateIntent(
    { type: 'open_download_page' },
    {
      service,
      openExternal: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
    },
  );

  assert.deepEqual(opened, [RELEASE_DOWNLOAD_PAGE_URL]);
  // Reported even though it succeeded: a success is what retracts an earlier
  // published failure, so it cannot be the silent case. The attempt is claimed
  // before the launch, which is what fixes its place among concurrent presses.
  assert.deepEqual(calls, ['beginDownloadPageAttempt', 'report:opened']);
});

test('a rejected launch is reported as a failure and does not reject the intent', async () => {
  // The user hears about it through the snapshot the service publishes, not
  // through this promise — the state stays `manual_update_required` and the
  // control stays pressable.
  const { service, calls } = fakeService();

  await assert.doesNotReject(() =>
    dispatchDesktopUpdateIntent(
      { type: 'open_download_page' },
      {
        service,
        openExternal: () => Promise.reject(new Error('no browser at https://token@example.test')),
      },
    ),
  );

  assert.deepEqual(calls, ['beginDownloadPageAttempt', 'report:failed']);
});

test('a launch that throws synchronously is a failure like any other', async () => {
  const { service, calls } = fakeService();

  await assert.doesNotReject(() =>
    dispatchDesktopUpdateIntent(
      { type: 'open_download_page' },
      {
        service,
        openExternal: () => {
          throw new Error('shell is unavailable');
        },
      },
    ),
  );

  assert.deepEqual(calls, ['beginDownloadPageAttempt', 'report:failed']);
});

test('an outcome that cannot be recorded does not fail the intent either', async () => {
  const { service } = fakeService();
  service.beginDownloadPageAttempt = () => () => Promise.reject(new Error('log volume is full'));

  await assert.doesNotReject(() =>
    dispatchDesktopUpdateIntent(
      { type: 'open_download_page' },
      { service, openExternal: () => Promise.reject(new Error('no browser')) },
    ),
  );
});

test('overlapping presses claim their attempts in press order, not completion order', async () => {
  // Ordering can only be established before the launch is awaited. Here the
  // second press launches and finishes while the first is still pending, so a
  // claim taken at completion would have them backwards.
  const { service, calls } = fakeService();
  const release: (() => void)[] = [];
  const open = (settle: 'now' | 'later') =>
    dispatchDesktopUpdateIntent(
      { type: 'open_download_page' },
      {
        service,
        openExternal: () =>
          settle === 'now'
            ? Promise.resolve()
            : new Promise<void>((resolve) => release.push(resolve)),
      },
    );

  const slow = open('later');
  await open('now');
  release[0]!();
  await slow;

  assert.deepEqual(calls, [
    'beginDownloadPageAttempt',
    'beginDownloadPageAttempt',
    'report:opened',
    'report:opened',
  ]);
});

test('the intent channel accepts the closed contract union and nothing else', () => {
  for (const type of [
    'check_for_updates',
    'request_restart',
    'confirm_restart',
    'cancel_restart',
    'open_download_page',
  ])
    assert.deepEqual(decodeDesktopUpdateIntent({ type }), { type });

  for (const payload of [
    undefined,
    null,
    'check_for_updates',
    {},
    { type: 'quit' },
    // Nothing may carry a destination, a version, or a command into main.
    { type: 'open_download_page', url: 'https://example.test' },
    { type: 'request_restart', force: true },
  ])
    assert.throws(
      () => decodeDesktopUpdateIntent(payload),
      `accepted a payload it must reject: ${JSON.stringify(payload)}`,
    );
});
