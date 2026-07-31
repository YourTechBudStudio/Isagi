import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  classifyPackagingRequest,
  normalizePackagingArguments,
  parseBuilderArguments,
  unsupportedPackagingMessage,
} from './electron-builder-target.mjs';

const withPolicy = (...args) => [...args, '--publish', 'never'];
const linuxArguments = withPolicy('--linux', 'AppImage', '--x64');
const localArguments = withPolicy('--dir');
const macArguments = (architecture) => withPolicy('--mac', 'dmg', 'zip', `--${architecture}`);

test('builder argument parsing retains the closed long-form grammar', () => {
  const request = parseBuilderArguments(macArguments('arm64'));
  assert.deepEqual([...request.targetsByPlatform], [['darwin', ['dmg', 'zip']]]);
  assert.deepEqual(request.architectures, ['arm64']);
  assert.deepEqual(request.publishPolicies, ['never']);
  assert.equal(request.dir, false);
  assert.deepEqual(parseBuilderArguments(['-m', '--arm64=true']).unrecognized, [
    '-m',
    '--arm64=true',
  ]);
});

test('pnpm forwarding removes only the documented architecture separator', () => {
  assert.deepEqual(
    normalizePackagingArguments(['--mac', 'dmg', 'zip', '--publish', 'never', '--', '--arm64']),
    ['--mac', 'dmg', 'zip', '--publish', 'never', '--arm64'],
  );
  for (const args of [
    ['--dir', '--publish', 'never', '--', '--arm64', '--x64'],
    ['--mac', 'dmg', 'zip', '--publish', 'never', '--', '--universal'],
    ['--mac', 'dmg', 'zip', '--publish', 'never', '--', '--arm64', 'extra'],
    ['--mac', '--', '--', '--arm64'],
  ]) {
    assert.deepEqual(normalizePackagingArguments(args), args);
  }
});

test('only the three explicit packaging contracts are accepted', () => {
  assert.deepEqual(classifyPackagingRequest(localArguments, 'darwin', 'arm64'), {
    kind: 'local-directory',
  });
  assert.deepEqual(classifyPackagingRequest(linuxArguments, 'darwin', 'arm64'), {
    architecture: 'x64',
    kind: 'linux-release',
  });
  for (const architecture of ['x64', 'arm64']) {
    assert.deepEqual(classifyPackagingRequest(macArguments(architecture), 'darwin', architecture), {
      architecture,
      kind: 'mac-release',
    });
  }
});

test('macOS release packaging rejects non-native, cross-architecture, and incomplete requests', () => {
  assert.match(reject(macArguments('arm64'), 'linux', 'arm64'), /requires a macOS host/u);
  assert.match(reject(macArguments('x64'), 'darwin', 'arm64'), /does not match native host/u);
  assert.match(
    reject(withPolicy('--mac', 'dmg', 'zip'), 'darwin', 'arm64'),
    /explicit --x64 or --arm64/u,
  );
  assert.match(
    reject(withPolicy('--mac', 'dmg', '--arm64'), 'darwin', 'arm64'),
    /targets must be exactly/u,
  );
  assert.match(
    reject(withPolicy('--mac', 'zip', 'dmg', '--arm64'), 'darwin', 'arm64'),
    /targets must be exactly/u,
  );
  assert.match(
    reject(withPolicy('--mac', 'dmg', 'zip', '--universal'), 'darwin', 'arm64'),
    /explicit --x64 or --arm64/u,
  );
});

test('local directory packaging cannot disguise a distribution request', () => {
  for (const args of [
    withPolicy('--dir', '--arm64'),
    withPolicy('--dir', '--mac'),
    withPolicy('--dir', '--linux', 'AppImage'),
  ]) {
    assert.match(
      reject(args, 'darwin', 'arm64'),
      /cannot select a platform, target, or architecture/u,
    );
  }
  assert.match(reject(withPolicy(), 'darwin', 'arm64'), /select exactly one supported platform/u);
});

test('Linux remains exactly one explicit x64 AppImage release', () => {
  assert.match(reject(withPolicy('--linux', 'deb', '--x64')), /deb is not AppImage/u);
  assert.match(reject(withPolicy('--linux', 'AppImage')), /requires explicit x64/u);
  assert.match(reject(withPolicy('--linux', 'AppImage', '--arm64')), /requires explicit x64/u);
  assert.match(reject(withPolicy('--linux', 'AppImage', '--x64', '--mac')), /select exactly one/u);
});

test('publishing policies, ambiguous architecture, and alternate spellings fail closed', () => {
  for (const args of [
    ['--dir'],
    ['--dir', '--publish', 'always'],
    ['--dir', '--publish', 'never', '--publish', 'never'],
    withPolicy('--mac=dmg', '--arm64'),
    withPolicy('-m', '--arm64'),
    withPolicy('--mac', 'dmg', 'zip', '--arm64=true'),
    withPolicy('--linux=AppImage', '--x64'),
    withPolicy('--mac', 'dmg', 'zip', '--x64', '--arm64'),
    withPolicy('--win', 'nsis', '--x64'),
  ]) {
    assert.equal(classifyPackagingRequest(args, 'darwin', 'arm64').kind, 'unsupported');
  }
});

test('unsupported request guidance names only the explicit commands', () => {
  const message = unsupportedPackagingMessage('test failure');
  assert.match(message, /pnpm pack:desktop/u);
  assert.match(message, /pnpm package:desktop:linux/u);
  assert.match(message, /pnpm package:desktop:mac -- --arm64\|--x64/u);
  assert.doesNotMatch(message, /pnpm package:desktop(?:[, .]|$)/u);
});

test('packaging scripts route through the wrapper and pin publish never', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
  );
  assert.equal('dist' in manifest.scripts, false);
  for (const script of ['dist:linux', 'dist:mac', 'pack:dir']) {
    const command = manifest.scripts[script];
    assert.equal(command.startsWith('node scripts/run-electron-builder.mjs'), true);
    assert.equal(command.includes('--publish never'), true);
  }
  assert.deepEqual(
    classifyPackagingRequest(manifest.scripts['pack:dir'].split(' ').slice(2), 'darwin', 'arm64'),
    { kind: 'local-directory' },
  );
  assert.deepEqual(
    classifyPackagingRequest(
      [...manifest.scripts['dist:mac'].split(' ').slice(2), '--arm64'],
      'darwin',
      'arm64',
    ),
    { architecture: 'arm64', kind: 'mac-release' },
  );
});

function reject(args, platform = 'linux', architecture = 'x64') {
  const request = classifyPackagingRequest(args, platform, architecture);
  assert.equal(request.kind, 'unsupported', `expected rejection for ${args.join(' ')}`);
  return request.reason;
}
