import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Fiber, Layer, SubscriptionRef } from 'effect';

import {
  DESKTOP_UPDATE_PROTOCOL_VERSION,
  type DesktopUpdateIntent,
  type DesktopUpdateSnapshot,
} from '@isagi/contracts';
import { runScoped } from '@isagi/testing';

import { decodeDesktopUpdateIntent, dispatchDesktopUpdateIntent } from './desktop-update-ipc.js';
import { RELEASE_DOWNLOAD_PAGE_URL } from './download-page.js';
import { DesktopUpdater, type ReportDownloadPageOutcome } from './service.js';
import { settle } from './test-support.js';

/** An updater that records which operation each intent reached. */
function fakeService(
  report: (calls: string[]) => ReportDownloadPageOutcome = (calls) => (outcome) =>
    Effect.sync(() => void calls.push(`report:${outcome}`)),
) {
  const calls: string[] = [];
  const record = (name: string) => Effect.sync(() => void calls.push(name));
  const layer = Layer.effect(
    DesktopUpdater,
    Effect.gen(function* () {
      const status = yield* SubscriptionRef.make<DesktopUpdateSnapshot>({
        protocolVersion: DESKTOP_UPDATE_PROTOCOL_VERSION,
        revision: 0,
        installedVersion: '1.2.3',
        state: 'idle',
      });
      return DesktopUpdater.of({
        status,
        checkForUpdates: record('checkForUpdates'),
        downloadUpdate: record('downloadUpdate'),
        requestRestart: record('requestRestart'),
        confirmRestart: record('confirmRestart'),
        cancelRestart: record('cancelRestart'),
        beginDownloadPageAttempt: record('beginDownloadPageAttempt').pipe(Effect.as(report(calls))),
        installer: {
          quitAndInstall: () => void calls.push('quitAndInstall'),
          recordInstallRejection: record('recordInstallRejection'),
        },
      });
    }),
  );
  return {
    calls,
    run: <A, E>(effect: Effect.Effect<A, E, DesktopUpdater>) =>
      runScoped(Effect.provide(effect, layer)),
  };
}

const openDownloadPage = (openExternal: (url: string) => Promise<void>) =>
  dispatchDesktopUpdateIntent({ type: 'open_download_page' }, { openExternal });

test('every intent reaches exactly one operation', async () => {
  const opened: string[] = [];
  for (const [intent, expected] of [
    [{ type: 'check_for_updates' }, 'checkForUpdates'],
    [{ type: 'download_update' }, 'downloadUpdate'],
    [{ type: 'request_restart' }, 'requestRestart'],
    [{ type: 'confirm_restart' }, 'confirmRestart'],
    [{ type: 'cancel_restart' }, 'cancelRestart'],
  ] as const satisfies readonly (readonly [DesktopUpdateIntent, string])[]) {
    const { calls, run } = fakeService();
    await run(
      dispatchDesktopUpdateIntent(intent, {
        openExternal: (url) => {
          opened.push(url);
          return Promise.resolve();
        },
      }),
    );
    assert.deepEqual(calls, [expected]);
  }
  assert.deepEqual(opened, [], 'no update operation may open a browser');
});

test('the download page is opened by main at a fixed destination, not by the updater', async () => {
  const { calls, run } = fakeService();
  const opened: string[] = [];

  await run(
    openDownloadPage((url) => {
      opened.push(url);
      return Promise.resolve();
    }),
  );

  assert.deepEqual(opened, [RELEASE_DOWNLOAD_PAGE_URL]);
  // Reported even though it succeeded: a success is what retracts an earlier
  // published failure, so it cannot be the silent case. The attempt is claimed
  // before the launch, which is what fixes its place among concurrent presses.
  assert.deepEqual(calls, ['beginDownloadPageAttempt', 'report:opened']);
});

test('a rejected launch is reported as a failure and does not reject the intent', async () => {
  // The user hears about it through the snapshot the service publishes, not
  // through this intent — the state stays `manual_update_required` and the
  // control stays pressable.
  const { calls, run } = fakeService();

  await assert.doesNotReject(() =>
    run(
      openDownloadPage(() => Promise.reject(new Error('no browser at https://token@example.test'))),
    ),
  );

  assert.deepEqual(calls, ['beginDownloadPageAttempt', 'report:failed']);
});

test('a launch that throws synchronously is a failure like any other', async () => {
  const { calls, run } = fakeService();

  await assert.doesNotReject(() =>
    run(
      openDownloadPage(() => {
        throw new Error('shell is unavailable');
      }),
    ),
  );

  assert.deepEqual(calls, ['beginDownloadPageAttempt', 'report:failed']);
});

test('an outcome that cannot be recorded does not fail the intent either', async () => {
  const { run } = fakeService(() => () => Effect.die(new Error('log volume is full')));

  await assert.doesNotReject(() =>
    run(openDownloadPage(() => Promise.reject(new Error('no browser')))),
  );
});

test('overlapping presses claim their attempts in press order, not completion order', async () => {
  // Ordering can only be established before the launch is awaited. Here the
  // second press launches and finishes while the first is still pending, so a
  // claim taken at completion would have them backwards.
  const { calls, run } = fakeService();
  const release: (() => void)[] = [];

  await run(
    Effect.gen(function* () {
      const slow = yield* Effect.forkChild(
        openDownloadPage(() => new Promise<void>((resolve) => release.push(resolve))),
      );
      yield* settle;
      yield* openDownloadPage(() => Promise.resolve());
      release[0]!();
      yield* Fiber.join(slow);
    }),
  );

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
    'download_update',
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
