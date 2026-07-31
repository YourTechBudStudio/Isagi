import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createPackage } from '@electron/asar';

import { verifyUpdaterPackage } from './verify-updater-package.mjs';

test('packaged updater verifier proves one external load site and the dependency closure', async () => {
  const fixture = await packageFixture();
  const result = await verifyUpdaterPackage(fixture);
  assert.equal(result.loadSiteCount, 1);
  assert.equal(result.dependencyCount, 2);
});

test('packaged updater verifier rejects missing closure and bundled implementation source', async () => {
  const missing = await packageFixture({ includeDependency: false });
  await assert.rejects(() => verifyUpdaterPackage(missing), /dependency is missing/u);

  const inlined = await packageFixture({ bundleSuffix: ' class AppUpdater {}' });
  await assert.rejects(() => verifyUpdaterPackage(inlined), /inlined electron-updater/u);
});

test('packaged updater verifier rejects an archive with no main bundle', async () => {
  const fixture = await packageFixture({ includeBundle: false });
  await assert.rejects(() => verifyUpdaterPackage(fixture), /main bundle is missing/u);
});

test('packaged updater verifier ignores an unpackaged bundle beside the archive', async () => {
  const fixture = await packageFixture({ bundleSuffix: ' class AppUpdater {}' });
  await mkdir(join(fixture.root, 'dist-electron/main'), { recursive: true });
  await writeFile(
    join(fixture.root, 'dist-electron/main/index.js'),
    `createRequire(import.meta.url)('electron-updater');`,
  );
  await assert.rejects(() => verifyUpdaterPackage(fixture), /inlined electron-updater/u);
});

async function packageFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'isagi-updater-package-'));
  const archiveRoot = join(root, 'archive');
  const updaterRoot = join(archiveRoot, 'node_modules/electron-updater');
  await mkdir(updaterRoot, { recursive: true });
  await writeFile(
    join(updaterRoot, 'package.json'),
    JSON.stringify({
      name: 'electron-updater',
      dependencies: { dependency: '1.0.0' },
    }),
  );
  if (options.includeDependency !== false) {
    const dependencyRoot = join(archiveRoot, 'node_modules/dependency');
    await mkdir(dependencyRoot, { recursive: true });
    await writeFile(join(dependencyRoot, 'package.json'), JSON.stringify({ name: 'dependency' }));
  }
  if (options.includeBundle !== false) {
    await mkdir(join(archiveRoot, 'dist-electron/main'), { recursive: true });
    await writeFile(
      join(archiveRoot, 'dist-electron/main/index.js'),
      `createRequire(import.meta.url)('electron-updater');${options.bundleSuffix ?? ''}`,
    );
  }
  const asarPath = join(root, 'app.asar');
  await createPackage(archiveRoot, asarPath);
  const sourceRoot = join(root, 'source');
  await mkdir(sourceRoot);
  await writeFile(join(sourceRoot, 'index.ts'), 'export {};');
  return { root, asarPath, sourceRoot };
}
