import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer, Stream, SubscriptionRef, type Scope } from 'effect';
import { TestClock } from 'effect/testing';

import type { DesktopUpdateSnapshot } from '@isagi/contracts';

import type { DesktopUpdaterConfig } from './config.js';
import { DesktopUpdater } from './service.js';
import {
  buildUpdater,
  FakeUpdater,
  recordingDiagnostics,
  settle,
  testConfig,
  unusedRuntimeHttp,
} from './test-support.js';

const runWithTestClock = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise);

/** `DesktopUpdater.layer` for one installation, counting how often electron-updater is loaded. */
const compose = Effect.fnUntraced(function* (
  installation: Partial<DesktopUpdaterConfig['Service']>,
) {
  const trail = recordingDiagnostics();
  const counter = { loads: 0 };
  const subject = yield* buildUpdater(
    DesktopUpdater.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          testConfig({
            loadUpdater: () => {
              counter.loads += 1;
              return new FakeUpdater();
            },
            ...installation,
          }),
          trail.layer,
          unusedRuntimeHttp,
        ),
      ),
    ),
  );
  return {
    ...subject,
    records: trail.records,
    loads: () => counter.loads,
    report: (outcome: 'opened' | 'failed') =>
      subject.updater.beginDownloadPageAttempt.pipe(Effect.flatMap((report) => report(outcome))),
  };
});

const ineligibleLinux = { platform: 'linux', environment: {} } as const;

test('unpackaged and unsupported packaged compositions never load the updater', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const development = yield* compose({ isPackaged: false, platform: 'darwin' });
      const unsupported = yield* compose({ isPackaged: true, platform: 'win32' });
      assert.equal(development.snapshot().state, 'disabled');
      assert.equal(unsupported.snapshot().state, 'disabled');
      assert.equal(development.loads() + unsupported.loads(), 0);
    }),
  ));

test('every packaged macOS composition loads the updater', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const subject = yield* compose({ isPackaged: true, platform: 'darwin' });
      assert.equal(subject.loads(), 1);
    }),
  ));

test('ineligible Linux is fixed as manual-only without constructing the updater', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const service = yield* compose(ineligibleLinux);
      assert.equal(service.snapshot().state, 'manual_update_required');
      assert.equal(service.loads(), 0);
      assert.equal(service.records[0]?.code, 'appimage_environment_missing');

      // This is the one composition where opening the download page is reachable,
      // so it must be able to persist a rejected launch rather than swallow it.
      yield* service.report('failed');
      assert.deepEqual(service.records[1], {
        operation: 'lifecycle',
        platform: 'linux',
        installedVersion: '1.2.3',
        code: 'download_page_rejected',
        summary: 'The release download page could not be opened.',
      });
    }),
  ));

test('the manual composition tells the renderer when a launch never reached a browser', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const service = yield* compose(ineligibleLinux);
      const pushed: DesktopUpdateSnapshot[] = [];
      yield* SubscriptionRef.changes(service.updater.status).pipe(
        // The first element is the snapshot current at subscription; only changes are pushes.
        Stream.drop(1),
        Stream.runForEach((snapshot) => Effect.sync(() => void pushed.push(snapshot))),
        Effect.forkScoped,
      );
      yield* settle;

      assert.equal(manualOpenFailure(service.snapshot()), null);

      yield* service.report('failed');
      assert.equal(manualOpenFailure(service.snapshot()), 'download_page_open_failed');
      assert.equal(
        service.snapshot().state,
        'manual_update_required',
        'the remedy is still the remedy',
      );
      assert.equal(service.snapshot().revision, 1, 'a changed fact is a new revision');

      // A retry that works retracts it, so the rail stops reporting a failure the
      // user has already recovered from.
      yield* service.report('opened');
      assert.equal(manualOpenFailure(service.snapshot()), null);
      assert.equal(service.snapshot().revision, 2);

      // Publishing nothing new is not a revision and not a push.
      yield* service.report('opened');
      assert.equal(service.snapshot().revision, 2);
      yield* settle;
      assert.deepEqual(
        pushed.map((snapshot) => manualOpenFailure(snapshot)),
        ['download_page_open_failed', null],
      );
    }),
  ));

test('an overtaken launch cannot overwrite the press that superseded it', () =>
  runWithTestClock(
    Effect.gen(function* () {
      // Presses arrive in order; launches finish in whatever order the OS decides.
      // `openFailure` means the last attempt, so the older one must lose even when
      // it completes last — otherwise a stale failure hides a browser that opened.
      const service = yield* compose(ineligibleLinux);

      const older = yield* service.updater.beginDownloadPageAttempt;
      const newer = yield* service.updater.beginDownloadPageAttempt;
      yield* newer('opened');
      yield* older('failed');

      assert.equal(
        manualOpenFailure(service.snapshot()),
        null,
        'the older failure spoke for the rail',
      );
      // It still happened, so it still gets a line — being superseded silences the
      // snapshot, not the diagnostic trail.
      assert.deepEqual(
        service.records.slice(1).map((record) => record.code),
        ['download_page_rejected'],
      );
    }),
  ));

test('an overtaken success cannot retract the failure the user is now looking at', () =>
  runWithTestClock(
    Effect.gen(function* () {
      // The mirror case, and the reason this is ordering rather than failure
      // suppression: a stale success must not clear a newer launch's failure either.
      const service = yield* compose(ineligibleLinux);

      const older = yield* service.updater.beginDownloadPageAttempt;
      const newer = yield* service.updater.beginDownloadPageAttempt;
      yield* newer('failed');
      yield* older('opened');

      assert.equal(manualOpenFailure(service.snapshot()), 'download_page_open_failed');
    }),
  ));

function manualOpenFailure(snapshot: DesktopUpdateSnapshot) {
  return snapshot.state === 'manual_update_required' ? snapshot.openFailure : 'not-manual';
}

test('a disabled composition has no reachable download page to record', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const service = yield* compose({ isPackaged: false, platform: 'darwin' });

      yield* service.report('failed');
      assert.deepEqual(
        service.records,
        [],
        'a development build shows no manual-install action at all',
      );
    }),
  ));

test('eligible Linux requires an absolute readable regular file with writable parent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'isagi-updater-composition-'));
  const appImage = join(directory, 'Isagi.AppImage');
  await writeFile(appImage, 'appimage');
  await runWithTestClock(
    Effect.gen(function* () {
      const subject = yield* compose({ platform: 'linux', environment: { APPIMAGE: appImage } });
      assert.equal(subject.loads(), 1);
    }),
  );
});
