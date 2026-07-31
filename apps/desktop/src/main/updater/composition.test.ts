import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { DesktopUpdateSnapshot } from '@isagi/contracts';

import { composeDesktopUpdater } from './composition.js';
import type { UpdaterAdapter } from './coordinator.js';
import type { UpdaterDiagnosticRecord, UpdaterDiagnosticSink } from './diagnostics.js';

const unusedUpdater = {} as UpdaterAdapter;

function application(isPackaged: boolean) {
  return {
    isPackaged,
    getVersion: () => '1.2.3',
    getPath: () => '/logs',
  };
}

function diagnosticSink(records: UpdaterDiagnosticRecord[]): UpdaterDiagnosticSink {
  return {
    write: (record) => {
      records.push(record);
      return Promise.resolve();
    },
    flush: () => Promise.resolve(),
  };
}

test('unpackaged and unsupported packaged compositions never load the updater', async () => {
  let loads = 0;
  const loadUpdater = () => {
    loads += 1;
    return unusedUpdater;
  };
  const development = await composeDesktopUpdater(application(false), {
    platform: 'darwin',
    loadUpdater,
  });
  const unsupported = await composeDesktopUpdater(application(true), {
    platform: 'win32',
    loadUpdater,
  });
  assert.equal(development.snapshot.state, 'disabled');
  assert.equal(unsupported.snapshot.state, 'disabled');
  assert.equal(loads, 0);
});

test('every packaged macOS composition loads the updater', async () => {
  let loads = 0;
  await composeDesktopUpdater(application(true), {
    platform: 'darwin',
    loadUpdater: () => {
      loads += 1;
      return unusedUpdater;
    },
  });
  assert.equal(loads, 1);
});

test('ineligible Linux is fixed as manual-only without constructing the updater', async () => {
  const records: UpdaterDiagnosticRecord[] = [];
  let loads = 0;
  const service = await composeDesktopUpdater(application(true), {
    platform: 'linux',
    environment: {},
    diagnostics: diagnosticSink(records),
    loadUpdater: () => {
      loads += 1;
      return unusedUpdater;
    },
  });
  assert.equal(service.snapshot.state, 'manual_update_required');
  assert.equal(loads, 0);
  assert.equal(records[0]?.code, 'appimage_environment_missing');

  // This is the one composition where opening the download page is reachable,
  // so it must be able to persist a rejected launch rather than swallow it.
  await service.beginDownloadPageAttempt()('failed');
  assert.deepEqual(records[1], {
    operation: 'lifecycle',
    platform: 'linux',
    installedVersion: '1.2.3',
    code: 'download_page_rejected',
    summary: 'The release download page could not be opened.',
  });
});

test('the manual composition tells the renderer when a launch never reached a browser', async () => {
  const records: UpdaterDiagnosticRecord[] = [];
  const pushed: DesktopUpdateSnapshot[] = [];
  const service = await composeDesktopUpdater(application(true), {
    platform: 'linux',
    environment: {},
    diagnostics: diagnosticSink(records),
    loadUpdater: () => unusedUpdater,
  });
  service.subscribe((snapshot) => pushed.push(snapshot));

  assert.equal(manualOpenFailure(service.snapshot), null);

  await service.beginDownloadPageAttempt()('failed');
  assert.equal(manualOpenFailure(service.snapshot), 'download_page_open_failed');
  assert.equal(service.snapshot.state, 'manual_update_required', 'the remedy is still the remedy');
  assert.equal(service.snapshot.revision, 1, 'a changed fact is a new revision');

  // A retry that works retracts it, so the rail stops reporting a failure the
  // user has already recovered from.
  await service.beginDownloadPageAttempt()('opened');
  assert.equal(manualOpenFailure(service.snapshot), null);
  assert.equal(service.snapshot.revision, 2);

  // Publishing nothing new is not a revision and not a push.
  await service.beginDownloadPageAttempt()('opened');
  assert.equal(service.snapshot.revision, 2);
  assert.deepEqual(
    pushed.map((snapshot) => manualOpenFailure(snapshot)),
    ['download_page_open_failed', null],
  );
});

test('an overtaken launch cannot overwrite the press that superseded it', async () => {
  // Presses arrive in order; launches finish in whatever order the OS decides.
  // `openFailure` means the last attempt, so the older one must lose even when
  // it completes last — otherwise a stale failure hides a browser that opened.
  const records: UpdaterDiagnosticRecord[] = [];
  const service = await composeDesktopUpdater(application(true), {
    platform: 'linux',
    environment: {},
    diagnostics: diagnosticSink(records),
    loadUpdater: () => unusedUpdater,
  });

  const older = service.beginDownloadPageAttempt();
  const newer = service.beginDownloadPageAttempt();
  await newer('opened');
  await older('failed');

  assert.equal(manualOpenFailure(service.snapshot), null, 'the older failure spoke for the rail');
  // It still happened, so it still gets a line — being superseded silences the
  // snapshot, not the diagnostic trail.
  assert.deepEqual(
    records.slice(1).map((record) => record.code),
    ['download_page_rejected'],
  );
});

test('an overtaken success cannot retract the failure the user is now looking at', async () => {
  // The mirror case, and the reason this is ordering rather than failure
  // suppression: a stale success must not clear a newer launch's failure either.
  const records: UpdaterDiagnosticRecord[] = [];
  const service = await composeDesktopUpdater(application(true), {
    platform: 'linux',
    environment: {},
    diagnostics: diagnosticSink(records),
    loadUpdater: () => unusedUpdater,
  });

  const older = service.beginDownloadPageAttempt();
  const newer = service.beginDownloadPageAttempt();
  await newer('failed');
  await older('opened');

  assert.equal(manualOpenFailure(service.snapshot), 'download_page_open_failed');
});

function manualOpenFailure(snapshot: DesktopUpdateSnapshot) {
  return snapshot.state === 'manual_update_required' ? snapshot.openFailure : 'not-manual';
}

test('a disabled composition has no reachable download page to record', async () => {
  const records: UpdaterDiagnosticRecord[] = [];
  const service = await composeDesktopUpdater(application(false), {
    platform: 'darwin',
    diagnostics: diagnosticSink(records),
  });

  await service.beginDownloadPageAttempt()('failed');
  assert.deepEqual(records, [], 'a development build shows no manual-install action at all');
});

test('eligible Linux requires an absolute readable regular file with writable parent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'isagi-updater-composition-'));
  const appImage = join(directory, 'Isagi.AppImage');
  await writeFile(appImage, 'appimage');
  let loads = 0;
  await composeDesktopUpdater(application(true), {
    platform: 'linux',
    environment: { APPIMAGE: appImage },
    loadUpdater: () => {
      loads += 1;
      return unusedUpdater;
    },
  });
  assert.equal(loads, 1);
});
