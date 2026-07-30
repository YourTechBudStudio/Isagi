import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

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
