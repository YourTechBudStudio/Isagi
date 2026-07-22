import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import {
  developmentDesktopEntryPath,
  manageDevelopmentDesktopEntry,
} from './development-desktop-entry.mjs';

const desktopName = 'studio.yourtechbud.isagi.desktop';

test('development desktop launcher installs the matching GNOME identity and removes only its own entry', async () => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'isagi-development-desktop-entry-'));
  const options = fixtureOptions(temporaryRoot);
  const entryPath = developmentDesktopEntryPath(options.dataHome, desktopName);
  try {
    const installed = await Effect.runPromise(manageDevelopmentDesktopEntry('install', options));
    assert.equal(installed.changed, true);
    assert.equal(installed.entryPath, entryPath);
    const contents = await readFile(entryPath, 'utf8');
    assert.match(contents, /^Name=Isagi$/m);
    assert.match(contents, /^Icon=\/repo with space\/apps\/desktop\/assets\/app-icon-linux\.png$/m);
    assert.match(contents, /^StartupWMClass=studio\.yourtechbud\.isagi$/m);
    assert.match(contents, /^X-Isagi-DevelopmentLauncher=\/repo with space$/m);
    assert.match(contents, /Exec="\/node" "\/pnpm\.cjs" --dir "\/repo with space" dev/);

    const unchanged = await Effect.runPromise(manageDevelopmentDesktopEntry('install', options));
    assert.equal(unchanged.changed, false);
    const removed = await Effect.runPromise(manageDevelopmentDesktopEntry('uninstall', options));
    assert.equal(removed.changed, true);
    await assert.rejects(() => readFile(entryPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('development desktop launcher refuses to replace or remove an unowned entry', async () => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'isagi-development-desktop-conflict-'));
  const options = fixtureOptions(temporaryRoot);
  const entryPath = developmentDesktopEntryPath(options.dataHome, desktopName);
  try {
    await mkdir(dirname(entryPath), { recursive: true });
    await writeFile(entryPath, '[Desktop Entry]\nName=Production Isagi\n', 'utf8');
    await assert.rejects(
      () => Effect.runPromise(manageDevelopmentDesktopEntry('install', options)),
      /Refusing to replace/,
    );
    await assert.rejects(
      () => Effect.runPromise(manageDevelopmentDesktopEntry('uninstall', options)),
      /Refusing to replace/,
    );
    assert.equal(await readFile(entryPath, 'utf8'), '[Desktop Entry]\nName=Production Isagi\n');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

function fixtureOptions(dataHome) {
  return {
    dataHome,
    desktopName,
    iconPath: '/repo with space/apps/desktop/assets/app-icon-linux.png',
    nodeExecutable: '/node',
    platform: 'linux',
    pnpmExecutable: '/pnpm.cjs',
    repositoryRoot: '/repo with space',
  };
}
