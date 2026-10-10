import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkDependencyPolicy,
  isBanned,
  lockedEffectVersions,
  workspacePackageDirs,
} from './dependency-policy.mjs';

const scriptPath = fileURLToPath(new URL('./dependency-policy.mjs', import.meta.url));

const WORKSPACE = "packages:\n  - 'apps/*'\n  - 'packages/*'\ncatalog:\n  effect: ~4.0.2\n";

/** A lockfile excerpt that resolves `effect` at each of `versions` (as pnpm 9+ writes packages and snapshots). */
const lockfile = (...versions) =>
  [
    "lockfileVersion: '9.0'",
    'catalogs:',
    '  default:',
    '    effect:',
    '      specifier: ~4.0.2',
    '      version: 4.0.2',
    'importers:',
    '  .:',
    '    devDependencies:',
    '      effect:',
    '        specifier: catalog:',
    `        version: ${versions[0] ?? '4.0.2'}`,
    'packages:',
    ...versions.map((version) => `  effect@${version}:\n    resolution: {integrity: sha512-x}`),
    '  effect-schema-helper@1.0.0:',
    '    resolution: {integrity: sha512-y}',
    'snapshots:',
    ...versions.map((version) => `  effect@${version}: {}`),
    "  '@effect/atom-react@4.0.2(effect@4.0.2)(react@19.0.0)':",
    '    dependencies:',
    '      effect: 4.0.2',
    '',
  ].join('\n');

const manifest = (dependencies = {}, devDependencies = {}) =>
  JSON.stringify({ name: 'x', dependencies, devDependencies });

/**
 * A throwaway repo: `files` maps repo-relative paths to text; workspace and lockfile default to a conforming tree.
 * @param {Record<string, string | null>} files a null value omits a default file
 */
const fixture = (files = {}) => {
  const repo = mkdtempSync(join(tmpdir(), 'isagi-dependency-policy-'));
  const all = {
    'pnpm-workspace.yaml': WORKSPACE,
    'pnpm-lock.yaml': lockfile('4.0.2'),
    'package.json': manifest({}, { effect: 'catalog:' }),
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    if (text === null) continue;
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  return {
    repo,
    run: () => checkDependencyPolicy(repo),
    [Symbol.dispose]: () => rmSync(repo, { recursive: true, force: true }),
  };
};

describe('dependency-policy', () => {
  test('a conforming workspace passes', () => {
    using f = fixture({
      'apps/web/package.json': manifest({
        effect: 'catalog:',
        '@effect/atom-react': 'catalog:',
        react: '^19.0.0',
      }),
      'packages/contracts/package.json': manifest({ effect: 'catalog:' }),
      'packages/no-manifest/README.md': 'not a package yet',
    });
    assert.deepEqual(f.run(), []);
  });

  test('D1 reports every banned package in any dependency field', () => {
    using f = fixture({
      'package.json': manifest({}, { effect: 'catalog:', '@effect/schema': '^0.75.0' }),
      'apps/web/package.json': JSON.stringify({
        dependencies: { '@tanstack/react-query': '^5.0.0', zustand: '^5.0.0' },
        devDependencies: { '@tanstack/react-query-devtools': '^5.0.0' },
        peerDependencies: { '@effect/rx-react': '^0.1.0' },
        optionalDependencies: { '@effect/experimental': '^0.1.0' },
      }),
    });
    const d1 = f.run().filter((error) => error.startsWith('D1 '));
    assert.deepEqual(
      d1.map((error) => error.split(' is banned')[0]),
      [
        'D1 package.json: devDependencies.@effect/schema',
        'D1 apps/web/package.json: dependencies.@tanstack/react-query',
        'D1 apps/web/package.json: dependencies.zustand',
        'D1 apps/web/package.json: devDependencies.@tanstack/react-query-devtools',
        'D1 apps/web/package.json: peerDependencies.@effect/rx-react',
        'D1 apps/web/package.json: optionalDependencies.@effect/experimental',
      ],
    );
  });

  test('D1 matches banned names exactly or by family prefix, never v4 look-alikes', () => {
    for (const name of [
      'zustand',
      '@effect/schema',
      '@effect/platform',
      '@effect/experimental',
      '@effect/rx',
      '@effect/rx-react',
      '@tanstack/react-query',
      '@tanstack/react-query-devtools',
    ])
      assert.equal(isBanned(name), true, name);
    for (const name of [
      'effect',
      '@effect/atom-react',
      '@effect/vitest',
      '@effect/platform-node',
      'zustand-like',
      '@tanstack/react-table',
    ])
      assert.equal(isBanned(name), false, name);
  });

  test('D2 requires catalog: for effect and every @effect/* dependency', () => {
    using f = fixture({
      'package.json': manifest({}, { effect: '^3.21.2' }),
      'apps/runtime/package.json': manifest({ effect: 'workspace:*', fastify: '^5.0.0' }),
      'apps/web/package.json': manifest(
        { '@effect/atom-react': '4.0.2' },
        { '@effect/vitest': 'catalog:' },
      ),
    });
    assert.deepEqual(f.run(), [
      'D2 package.json: devDependencies.effect is "^3.21.2"; declare it as "catalog:" (version lives in pnpm-workspace.yaml)',
      'D2 apps/runtime/package.json: dependencies.effect is "workspace:*"; declare it as "catalog:" (version lives in pnpm-workspace.yaml)',
      'D2 apps/web/package.json: dependencies.@effect/atom-react is "4.0.2"; declare it as "catalog:" (version lives in pnpm-workspace.yaml)',
    ]);
  });

  test('D3 fails when the lockfile resolves two effect versions, or none', () => {
    using split = fixture({ 'pnpm-lock.yaml': lockfile('3.21.2', '4.0.2') });
    assert.deepEqual(split.run(), [
      'D3 pnpm-lock.yaml resolves effect at 3.21.2, 4.0.2; expected exactly one',
    ]);
    using none = fixture({ 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" });
    assert.deepEqual(none.run(), [
      'D3 pnpm-lock.yaml resolves effect at no version; expected exactly one',
    ]);
  });

  test('lockfile parsing reads package keys, quoted or with peer suffixes, and ignores other packages', () => {
    assert.deepEqual(lockedEffectVersions(lockfile('4.0.2')), ['4.0.2']);
    assert.deepEqual(
      lockedEffectVersions("packages:\n  'effect@4.0.3(peer@1.0.0)':\n  effect-other@9.9.9:\n"),
      ['4.0.3'],
    );
  });

  test('manifests come from the pnpm-workspace.yaml package globs', () => {
    using f = fixture({
      'pnpm-workspace.yaml':
        'packages:\n  - \'tools/*\'\n  - "single"\n  - missing/*\nallowBuilds: {}\n',
      'tools/one/package.json': manifest({ zustand: '^5.0.0' }),
      'single/package.json': manifest({ effect: '^4.0.2' }),
      'apps/web/package.json': manifest({ zustand: '^5.0.0' }),
    });
    assert.deepEqual(workspacePackageDirs(f.repo), ['single', 'tools/one']);
    assert.deepEqual(
      f.run().map((error) => error.split(':')[0]),
      ['D2 single/package.json', 'D1 tools/one/package.json'],
    );
  });

  test('a missing lockfile or workspace file, or an unsupported workspace glob, is an error', () => {
    using noLock = fixture({ 'pnpm-lock.yaml': null });
    assert.throws(() => noLock.run(), /pnpm-lock\.yaml does not exist/);
    using noWorkspace = fixture({ 'pnpm-workspace.yaml': null });
    assert.throws(() => noWorkspace.run(), /pnpm-workspace\.yaml does not exist/);
    using glob = fixture({ 'pnpm-workspace.yaml': "packages:\n  - 'apps/**'\n" });
    assert.throws(() => glob.run(), /unsupported pnpm-workspace\.yaml package pattern apps\/\*\*/);
  });

  test('the CLI exits 1 and prints violations for a failing tree, 0 for a clean one', () => {
    using failing = fixture({ 'apps/web/package.json': manifest({ zustand: '^5.0.0' }) });
    const failed = spawnSync(process.execPath, [scriptPath, failing.repo], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /D1 apps\/web\/package\.json: dependencies\.zustand is banned/);
    assert.match(failed.stderr, /dependency-policy: 1 violation\(s\)/);
    using clean = fixture();
    const passed = spawnSync(process.execPath, [scriptPath, clean.repo], { encoding: 'utf8' });
    assert.equal(passed.status, 0, passed.stderr);
  });
});
