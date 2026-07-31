import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { desktopLicenseBundle, verifyDesktopLicenseBundle } from './desktop-license-bundle.mjs';

test('desktop license contract and Builder mappings stay complete and byte-identical', () => {
  const resources = mkdtempSync(resolve(tmpdir(), 'isagi-license-bundle-'));
  const licenses = resolve(resources, desktopLicenseBundle.directoryName);
  mkdirSync(licenses);
  try {
    const configuration = readBuilderConfiguration();
    for (const file of desktopLicenseBundle.files) {
      assert.equal(
        configuration.includes(`  - from: ${file.builderFrom}\n    to: licenses/${file.name}\n`),
        true,
        `electron-builder.yml does not map ${file.name}`,
      );
      copyFileSync(file.sourcePath, resolve(licenses, file.name));
    }

    const verified = verifyDesktopLicenseBundle(resources, 'fixture app');
    assert.equal(verified.fileCount, desktopLicenseBundle.files.length);
    assert.equal(verified.totalBytes > 0, true);

    const notice = resolve(licenses, 'Isagi-NOTICE.txt');
    writeFileSync(notice, 'changed');
    assert.throws(
      () => verifyDesktopLicenseBundle(resources, 'fixture app'),
      /Isagi-NOTICE\.txt does not match its source/u,
    );
    copyFileSync(resolve(import.meta.dirname, '../../../NOTICE'), notice);

    writeFileSync(resolve(licenses, 'unexpected.txt'), 'surprise');
    assert.throws(
      () => verifyDesktopLicenseBundle(resources, 'fixture app'),
      /unexpected entry unexpected\.txt/u,
    );
  } finally {
    rmSync(resources, { force: true, recursive: true });
  }
});

function readBuilderConfiguration() {
  return readFileSync(resolve(import.meta.dirname, '../electron-builder.yml'), 'utf8');
}
