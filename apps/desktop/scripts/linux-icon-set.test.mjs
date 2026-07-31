import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  cleanupLinuxIconPackaging,
  linuxIconSizes,
  linuxIconSourcePath,
  prepareLinuxIconPackaging,
} from './linux-icon-set.mjs';
import { decodePngDimensions } from './verify-linux-release.mjs';

test('Linux icon input forces electron-builder generation from the canonical source', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'isagi-linux-icons-'));
  const inputDirectory = resolve(root, 'icons');
  const conversionDirectory = resolve(root, 'release/.icon-set');
  try {
    mkdirSync(inputDirectory);
    writeFileSync(resolve(inputDirectory, '96x96.png'), 'stale generated icon');
    prepareLinuxIconPackaging({ conversionDirectory, inputDirectory });
    assert.deepEqual(readdirSync(inputDirectory), ['icon.png']);
    const stagedPath = resolve(inputDirectory, 'icon.png');
    assert.equal(readFileSync(stagedPath).equals(readFileSync(linuxIconSourcePath)), true);
    assert.deepEqual(decodePngDimensions(readFileSync(stagedPath)), {
      height: 1200,
      width: 1200,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('Linux icon sizes match the pinned electron-builder PNG-set generator', () => {
  assert.deepEqual(linuxIconSizes, [16, 24, 32, 48, 64, 128, 256, 512]);
  const installer = readFileSync(resolve(import.meta.dirname, 'install-isagi-linux.sh'), 'utf8');
  assert.equal(installer.includes(`ICON_SIZES='${linuxIconSizes.join(' ')}'`), true);
});

test('Linux icon packaging owns the private electron-builder conversion directory', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'isagi-linux-icon-packaging-'));
  const inputDirectory = resolve(root, 'input');
  const conversionDirectory = resolve(root, 'release/.icon-set');
  try {
    mkdirSync(conversionDirectory, { recursive: true });
    writeFileSync(resolve(conversionDirectory, 'stale.png'), 'stale generated icon');

    const packaging = prepareLinuxIconPackaging({ conversionDirectory, inputDirectory });
    assert.equal(existsSync(conversionDirectory), false);

    mkdirSync(conversionDirectory, { recursive: true });
    writeFileSync(resolve(conversionDirectory, 'icon_16x16.png'), 'generated icon');
    cleanupLinuxIconPackaging(packaging);
    assert.equal(existsSync(conversionDirectory), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
