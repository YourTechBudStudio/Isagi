import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { linuxIconSizes, linuxIconSourcePath, prepareLinuxIconInput } from './linux-icon-set.mjs';
import { decodePngDimensions } from './verify-linux-release.mjs';

test('Linux icon input forces electron-builder generation from the canonical source', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'isagi-linux-icons-'));
  const inputDirectory = resolve(root, 'icons');
  try {
    mkdirSync(inputDirectory);
    writeFileSync(resolve(inputDirectory, '96x96.png'), 'stale generated icon');
    const prepared = prepareLinuxIconInput({ inputDirectory });
    assert.deepEqual(readdirSync(inputDirectory), ['icon.png']);
    assert.equal(readFileSync(prepared.stagedPath).equals(readFileSync(linuxIconSourcePath)), true);
    assert.deepEqual(decodePngDimensions(readFileSync(prepared.stagedPath)), {
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
