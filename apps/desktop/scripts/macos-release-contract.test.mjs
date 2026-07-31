import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { macReleaseCredentialNames, preflightMacRelease } from './macos-release-contract.mjs';

const completeEnvironment = Object.fromEntries(
  macReleaseCredentialNames.map((name) => [
    name,
    name === 'APPLE_TEAM_ID' ? 'TEAM123456' : 'configured',
  ]),
);

test('macOS release preflight requires the one six-variable credential contract', () => {
  assert.deepEqual(
    preflightMacRelease({
      architecture: 'arm64',
      env: completeEnvironment,
      hostArchitecture: 'arm64',
      platform: 'darwin',
    }),
    { architecture: 'arm64', expectedTeamId: 'TEAM123456' },
  );
  for (const missingName of macReleaseCredentialNames) {
    const env = { ...completeEnvironment, [missingName]: '  ' };
    assert.throws(
      () =>
        preflightMacRelease({
          architecture: 'arm64',
          env,
          hostArchitecture: 'arm64',
          platform: 'darwin',
        }),
      (error) =>
        error.message.includes(missingName) &&
        !Object.values(completeEnvironment).some((value) => error.message.includes(value)),
    );
  }
});

test('macOS release preflight refuses cross-building before inspecting credentials', () => {
  assert.throws(
    () =>
      preflightMacRelease({
        architecture: 'x64',
        env: completeEnvironment,
        hostArchitecture: 'arm64',
        platform: 'darwin',
      }),
    /does not match native host/u,
  );
  assert.throws(
    () =>
      preflightMacRelease({
        architecture: 'arm64',
        env: completeEnvironment,
        hostArchitecture: 'arm64',
        platform: 'linux',
      }),
    /requires a macOS host/u,
  );
});

test('local and release Builder configurations cannot inherit each other’s macOS behavior', () => {
  const root = resolve(import.meta.dirname, '..');
  const base = readFileSync(resolve(root, 'electron-builder.yml'), 'utf8');
  const local = readFileSync(resolve(root, 'electron-builder.local.yml'), 'utf8');
  const release = readFileSync(resolve(root, 'electron-builder.mac-release.yml'), 'utf8');
  assert.doesNotMatch(base, /identity:|notarize:|forceCodeSigning:|afterPack:/u);
  assert.match(local, /identity: null/u);
  assert.match(local, /output: release\/local/u);
  assert.match(local, /- dir/u);
  assert.doesNotMatch(local, /notarize:|dmg|zip|afterPack:/u);
  for (const expected of [
    'afterPack: scripts/verify-macos-pre-sign.cjs',
    'output: release/mac-${arch}',
    'artifactName: Isagi-mac-${arch}.${ext}',
    'forceCodeSigning: true',
    'hardenedRuntime: true',
    'notarize: true',
    'entitlements: assets/entitlements.mac.plist',
    'entitlementsInherit: assets/entitlements.mac.inherit.plist',
    '- dmg',
    '- zip',
  ]) {
    assert.match(release, new RegExp(escapeRegExp(expected), 'u'));
  }
  assert.doesNotMatch(release, /identity: null/u);
});

test('main and inherited entitlements contain only the JIT entitlement', () => {
  for (const name of ['entitlements.mac.plist', 'entitlements.mac.inherit.plist']) {
    const contents = readFileSync(resolve(import.meta.dirname, '../assets', name), 'utf8');
    const keys = [...contents.matchAll(/<key>([^<]+)<\/key>/gu)].map((match) => match[1]);
    assert.deepEqual(keys, ['com.apple.security.cs.allow-jit']);
    assert.match(contents, /<true\/>/u);
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
