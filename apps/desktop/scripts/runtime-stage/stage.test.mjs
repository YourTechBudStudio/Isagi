import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { Effect, Exit } from 'effect';

import { runtimePackageExternals } from '../../../runtime/runtime-externals.mjs';
import { repoRoot, runtimeRoot } from './paths.mjs';
import { runCommand } from './process.mjs';
import { takeCompleteLines } from './smoke.mjs';
import {
  createFingerprint,
  createFingerprintInputs,
  isValidNativeCache,
  pruneNodePtyPrebuilds,
  recoverGeneratedState,
  validateDependencyTree,
} from './stage.mjs';

test('fingerprint is stable for object key order and invalidates on an input change', () => {
  const first = createFingerprint({ recipe: 1, versions: { native: '1.0.0', electron: '43.1.0' } });
  const reordered = createFingerprint({
    versions: { electron: '43.1.0', native: '1.0.0' },
    recipe: 1,
  });
  const changed = createFingerprint({
    recipe: 2,
    versions: { native: '1.0.0', electron: '43.1.0' },
  });

  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});

test('native cache fingerprint covers the lockfile, Electron context, dependencies, rebuild recipe, and host', () => {
  const inputs = createFingerprintInputs({
    electron: {
      abi: '148',
      arch: 'arm64',
      node: 'v24.18.0',
      platform: 'darwin',
      version: '43.1.0',
    },
    dependencyVersions: { 'better-sqlite3': '12.11.1', 'node-pty': '1.1.0' },
    rebuildVersion: '4.2.0',
  });
  const expectedKeys = [
    'dependencyVersions',
    'electron',
    'libc',
    'lockfileSha256',
    'rebuildVersion',
    'runtimeNativeExternals',
    'runtimePackageExternals',
    'stagingRecipeVersion',
  ];
  assert.deepEqual(Object.keys(inputs), expectedKeys);

  const baseline = createFingerprint(inputs);
  const mutations = [
    (value) => (value.dependencyVersions['node-pty'] = '2.0.0'),
    (value) => (value.electron.version = '44.0.0'),
    (value) => (value.electron.node = 'v25.0.0'),
    (value) => (value.electron.abi = '149'),
    (value) => (value.electron.platform = 'linux'),
    (value) => (value.electron.arch = 'x64'),
    (value) => (value.libc = 'glibc-test'),
    (value) => (value.lockfileSha256 = 'changed'),
    (value) => (value.rebuildVersion = '5.0.0'),
    (value) => value.runtimeNativeExternals.push('native-test'),
    (value) => value.runtimePackageExternals.push('external-test'),
    (value) => (value.stagingRecipeVersion += 1),
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(inputs);
    mutate(changed);
    assert.notEqual(createFingerprint(changed), baseline);
  }
});

test('an incomplete cache directory is never a cache hit', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'isagi-native-cache-test-'));
  try {
    mkdirSync(resolve(root, 'node_modules'), { recursive: true });
    assert.equal(isValidNativeCache(root, 'fingerprint', {}), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('node-pty staging keeps only the target platform prebuild', () => {
  const packageRoot = mkdtempSync(resolve(tmpdir(), 'isagi-node-pty-prune-test-'));
  const prebuildsRoot = resolve(packageRoot, 'prebuilds');
  for (const name of ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64']) {
    mkdirSync(resolve(prebuildsRoot, name), { recursive: true });
    writeFileSync(resolve(prebuildsRoot, name, 'native.node'), name, 'utf8');
  }
  writeFileSync(resolve(prebuildsRoot, 'README.md'), 'not a runtime prebuild', 'utf8');

  try {
    assert.deepEqual(pruneNodePtyPrebuilds(packageRoot, { arch: 'arm64', platform: 'darwin' }), [
      'README.md',
      'darwin-x64',
      'win32-arm64',
      'win32-x64',
    ]);
    assert.equal(existsSync(resolve(prebuildsRoot, 'darwin-arm64/native.node')), true);
    assert.deepEqual(readdirSync(prebuildsRoot), ['darwin-arm64']);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test('node-pty staging removes an empty prebuild set when no target exists', () => {
  const packageRoot = mkdtempSync(resolve(tmpdir(), 'isagi-node-pty-prune-empty-test-'));
  const prebuildsRoot = resolve(packageRoot, 'prebuilds');
  mkdirSync(resolve(prebuildsRoot, 'darwin-x64'), { recursive: true });

  try {
    assert.deepEqual(pruneNodePtyPrebuilds(packageRoot, { arch: 'x64', platform: 'linux' }), [
      'darwin-x64',
    ]);
    assert.equal(existsSync(prebuildsRoot), false);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test('the staging importer owns exactly the declared runtime externals', () => {
  const runtimeManifest = JSON.parse(readFileSync(resolve(runtimeRoot, 'package.json'), 'utf8'));
  const stagingManifest = JSON.parse(
    readFileSync(resolve(repoRoot, 'packages/runtime-stage-dependencies/package.json'), 'utf8'),
  );
  assert.deepEqual(
    Object.keys(stagingManifest.dependencies).sort(),
    [...runtimePackageExternals].sort(),
  );
  for (const name of runtimePackageExternals) {
    assert.equal(
      stagingManifest.dependencies[name],
      runtimeManifest.dependencies[name],
      `${name} must use the runtime dependency specifier`,
    );
  }
});

test('command failures preserve exit and command context', async () => {
  const exit = await Effect.runPromiseExit(
    runCommand(process.execPath, ['-e', 'process.exit(7)'], { capture: true }),
  );
  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    const error = exit.cause.error;
    assert.equal(error?._tag, 'StageCommandError');
    assert.equal(error?.exitCode, 7);
    assert.equal(error?.command, process.execPath);
  }
});

test('command timeouts are distinguished from external termination', async () => {
  const exit = await Effect.runPromiseExit(
    runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      capture: true,
      timeoutMs: 25,
    }),
  );
  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) {
    const error = exit.cause.error;
    assert.equal(error?._tag, 'StageCommandError');
    assert.equal(error?.timedOut, true);
    assert.match(error?.message, /timed out/);
  }
});

test('dependency validation rejects packages resolved from an ancestor node_modules', () => {
  const parent = mkdtempSync(resolve(tmpdir(), 'isagi-stage-containment-test-'));
  const root = resolve(parent, 'nested', 'runtime');
  const dependencyVersions = Object.fromEntries(
    runtimePackageExternals.map((name) => [name, '1.0.0']),
  );
  mkdirSync(root, { recursive: true });
  writeFileSync(
    resolve(root, 'package.json'),
    JSON.stringify({ dependencies: dependencyVersions }),
    'utf8',
  );
  for (const name of runtimePackageExternals) {
    const packageRoot = resolve(parent, 'node_modules', name);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      resolve(packageRoot, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', main: 'index.js' }),
      'utf8',
    );
    writeFileSync(resolve(packageRoot, 'index.js'), 'module.exports = {};\n', 'utf8');
  }

  try {
    assert.throws(
      () => validateDependencyTree(root, dependencyVersions, { requireNativeArtifacts: false }),
      /resolves outside the staged tree/,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('readiness parsing retains partial lines until a newline arrives', () => {
  const first = takeCompleteLines('', 'noise\nISAGI_RUNTIME_READY {"url":"http://127.0.0.1');
  assert.deepEqual(first.lines, ['noise']);
  assert.match(first.carry, /^ISAGI_RUNTIME_READY/);

  const second = takeCompleteLines(first.carry, ':1234"}\n');
  assert.deepEqual(second.lines, ['ISAGI_RUNTIME_READY {"url":"http://127.0.0.1:1234"}']);
  assert.equal(second.carry, '');
});

test('recovery restores the previous stage and removes stale next directories', () => {
  const generatedRoot = mkdtempSync(resolve(tmpdir(), 'isagi-stage-recovery-test-'));
  const stageRoot = resolve(generatedRoot, 'runtime');
  const stageBackupRoot = resolve(generatedRoot, 'runtime.previous');
  const nativeCacheRoot = resolve(generatedRoot, 'runtime-native-cache');
  const stale = `${stageRoot}.next-test`;
  mkdirSync(stageBackupRoot, { recursive: true });
  mkdirSync(stale, { recursive: true });
  writeFileSync(resolve(stageBackupRoot, 'marker'), 'previous', 'utf8');

  try {
    recoverGeneratedState({ generatedRoot, nativeCacheRoot, stageBackupRoot, stageRoot });
    assert.equal(readFileSync(resolve(stageRoot, 'marker'), 'utf8'), 'previous');
    assert.equal(existsSync(stale), false);
  } finally {
    rmSync(generatedRoot, { recursive: true, force: true });
  }
});
