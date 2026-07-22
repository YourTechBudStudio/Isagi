import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { Cause, Effect, Exit } from 'effect';

import { prepareElectronExecutable } from './electron-runtime.mjs';

test('returns an existing Electron executable without running the installer', async () => {
  const fixture = createFixture();
  try {
    const executable = createInstalledExecutable(fixture.packageRoot);
    const prepared = [];
    const result = await Effect.runPromise(
      prepareElectronExecutable({
        desktopRoot: fixture.desktopRoot,
        onPrepare: () => prepared.push(true),
      }),
    );

    assert.equal(result, executable);
    assert.deepEqual(prepared, []);
    assert.equal(existsSync(resolve(fixture.packageRoot, 'installer-ran')), false);
  } finally {
    fixture.dispose();
  }
});

test('installs Electron when the executable is absent', async () => {
  const fixture = createFixture();
  try {
    const prepared = [];
    const result = await Effect.runPromise(
      prepareElectronExecutable({
        desktopRoot: fixture.desktopRoot,
        onPrepare: () => prepared.push(true),
      }),
    );

    assert.equal(result, resolve(fixture.packageRoot, 'dist/fake-electron'));
    assert.deepEqual(prepared, [true]);
    assert.equal(existsSync(resolve(fixture.packageRoot, 'installer-ran')), true);
  } finally {
    fixture.dispose();
  }
});

test('removes a partial Electron installation before retrying', async () => {
  const fixture = createFixture({ rejectStaleDist: true });
  try {
    mkdirSync(resolve(fixture.packageRoot, 'dist'), { recursive: true });
    writeFileSync(resolve(fixture.packageRoot, 'dist/stale'), 'partial');
    writeFileSync(resolve(fixture.packageRoot, 'path.txt'), 'dist/missing-electron');

    const result = await Effect.runPromise(
      prepareElectronExecutable({ desktopRoot: fixture.desktopRoot }),
    );

    assert.equal(result, resolve(fixture.packageRoot, 'dist/fake-electron'));
    assert.equal(existsSync(resolve(fixture.packageRoot, 'dist/stale')), false);
  } finally {
    fixture.dispose();
  }
});

test('reports installer exit details', async () => {
  const fixture = createFixture({ failInstaller: true });
  try {
    const exit = await Effect.runPromiseExit(
      prepareElectronExecutable({ desktopRoot: fixture.desktopRoot }),
    );

    assert.equal(Exit.isFailure(exit), true);
    assert.match(Cause.pretty(exit.cause), /exit code 7/);
    assert.match(Cause.pretty(exit.cause), /fixture installer exploded/);
  } finally {
    fixture.dispose();
  }
});

function createFixture({ failInstaller = false, rejectStaleDist = false } = {}) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'isagi-electron-runtime-')));
  const desktopRoot = resolve(root, 'apps/desktop');
  const packageRoot = resolve(root, 'node_modules/electron');
  mkdirSync(desktopRoot, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(resolve(desktopRoot, 'package.json'), '{}');
  writeFileSync(
    resolve(packageRoot, 'package.json'),
    JSON.stringify({ name: 'electron', version: '1.0.0', main: 'index.js' }),
  );
  writeFileSync(resolve(packageRoot, 'index.js'), 'module.exports = "unused";\n');
  writeFileSync(
    resolve(packageRoot, 'install.js'),
    installerFixture({ failInstaller, rejectStaleDist }),
  );
  return {
    desktopRoot,
    packageRoot,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function createInstalledExecutable(packageRoot) {
  const executable = resolve(packageRoot, 'dist/fake-electron');
  mkdirSync(resolve(packageRoot, 'dist'), { recursive: true });
  writeFileSync(executable, '#!/bin/sh\n');
  chmodSync(executable, 0o755);
  writeFileSync(resolve(packageRoot, 'path.txt'), 'fake-electron');
  return executable;
}

function installerFixture({ failInstaller, rejectStaleDist }) {
  if (failInstaller) {
    return `console.error('fixture installer exploded'); process.exit(7);\n`;
  }
  return `
const { chmodSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const root = __dirname;
if (${JSON.stringify(rejectStaleDist)} && existsSync(resolve(root, 'dist/stale'))) process.exit(9);
mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/fake-electron'), '#!/bin/sh\\n');
chmodSync(resolve(root, 'dist/fake-electron'), 0o755);
writeFileSync(resolve(root, 'path.txt'), 'fake-electron');
writeFileSync(resolve(root, 'installer-ran'), 'yes');
`;
}
