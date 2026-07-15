import assert from 'node:assert/strict';
import { cpSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { verifyRuntimeStageParity } from './parity.mjs';

test('runtime stage parity distinguishes bytes, layout, metadata, and executable permissions', () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'isagi-runtime-parity-'));
  const source = resolve(temporaryRoot, 'source');
  const packaged = resolve(temporaryRoot, 'packaged');
  try {
    createFixture(source);
    cpSync(source, packaged, { recursive: true });
    assert.deepEqual(verifyRuntimeStageParity(source, packaged, 'darwin'), {
      byteFileCount: 8,
      dependencyVersions: { 'node-pty': '1.1.0' },
      electron: {
        abi: '148',
        arch: 'arm64',
        node: 'v24.18.0',
        platform: 'darwin',
        version: '43.1.0',
      },
      executableFileCount: 1,
    });

    writeFileSync(resolve(packaged, 'assets/manifest.json'), 'changed');
    assert.throws(() => verifyRuntimeStageParity(source, packaged, 'darwin'), /byte hash differs/);
    cpSync(source, packaged, { recursive: true, force: true });
    chmodSync(resolve(packaged, 'node_modules/node-pty/spawn-helper'), 0o644);
    assert.throws(
      () => verifyRuntimeStageParity(source, packaged, 'darwin'),
      /permission mode differs/,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function createFixture(root) {
  for (const directory of ['assets', 'drizzle/meta', 'node_modules/node-pty']) {
    mkdirSync(resolve(root, directory), { recursive: true });
  }
  const metadata = {
    dependencyVersions: { 'node-pty': '1.1.0' },
    electron: {
      abi: '148',
      arch: 'arm64',
      node: 'v24.18.0',
      platform: 'darwin',
      version: '43.1.0',
    },
    entrypoint: 'index.js',
    fingerprint: 'fingerprint',
    layoutVersion: 1,
  };
  writeFileSync(resolve(root, 'index.js'), 'entry');
  writeFileSync(resolve(root, 'package.json'), '{"type":"module"}');
  writeFileSync(resolve(root, 'runtime-stage.json'), JSON.stringify(metadata));
  writeFileSync(resolve(root, 'assets/manifest.json'), 'asset');
  writeFileSync(resolve(root, 'drizzle/meta/_journal.json'), 'migration');
  writeFileSync(resolve(root, 'node_modules/node-pty/pty.node'), 'native');
  writeFileSync(resolve(root, 'node_modules/node-pty/spawn-helper'), 'helper');
  mkdirSync(resolve(root, 'node_modules/node-pty/prebuilds/other-platform'), { recursive: true });
  writeFileSync(
    resolve(root, 'node_modules/node-pty/prebuilds/other-platform/spawn-helper'),
    'unused helper',
  );
  chmodSync(resolve(root, 'node_modules/node-pty/spawn-helper'), 0o755);
}
