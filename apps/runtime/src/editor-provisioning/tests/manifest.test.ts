import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { codeServerManifestSource } from '../../runtime-assets.js';
import { artifactForPlatform, codeServerManifest, editorPlatformKey } from '../manifest.js';

const repositorySource = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'code-server.manifest.json',
);

// The three targets `.github/workflows/release.yml` builds. `linux-arm64` exists
// upstream and is deliberately absent.
const supportedPlatformKeys = ['darwin-arm64', 'darwin-x64', 'linux-x64'] as const;

test('the shipped manifest decodes and pins the release matrix exactly', () => {
  assert.equal(codeServerManifest.manifestVersion, 1);
  assert.equal(codeServerManifest.version, '4.135.0');
  assert.deepEqual(Object.keys(codeServerManifest.artifacts).sort(), [...supportedPlatformKeys]);

  // Asserted against the raw source rather than the decoded value: the schema
  // ignores excess properties, so a fourth platform key would decode cleanly and
  // silently ship an unaudited artifact.
  const raw = JSON.parse(codeServerManifestSource) as {
    readonly artifacts: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(raw.artifacts).sort(), [...supportedPlatformKeys]);
});

test('every artifact carries a 64-hex digest and a relative executable path', () => {
  for (const key of supportedPlatformKeys) {
    const artifact = artifactForPlatform(codeServerManifest, key);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/, `${key} digest`);
    assert.equal(artifact.archive, 'tar_gz');
    assert.equal(artifact.stripComponents, 1);
    assert.equal(artifact.executablePath, 'bin/code-server');
    // A relative path is what lets the install root move with the data
    // directory; an absolute one would be baked into the receipt.
    assert.ok(!artifact.executablePath.startsWith('/'), `${key} executable path is relative`);
    assert.ok(
      artifact.url.startsWith(
        `https://github.com/coder/code-server/releases/download/v${codeServerManifest.version}/`,
      ),
      `${key} url points at the pinned release`,
    );
  }
});

test('the generated asset is byte-identical to the repository source', () => {
  // The manifest is reviewed in the repository and read from the asset root at
  // run time. If the sync step ever transformed it, the audited bytes and the
  // shipped bytes would be different artifacts.
  assert.equal(codeServerManifestSource, readFileSync(repositorySource, 'utf8'));
});

test('platform mapping covers the supported matrix and refuses everything else', () => {
  assert.equal(editorPlatformKey({ platform: 'darwin', arch: 'arm64' }), 'darwin-arm64');
  assert.equal(editorPlatformKey({ platform: 'darwin', arch: 'x64' }), 'darwin-x64');
  assert.equal(editorPlatformKey({ platform: 'linux', arch: 'x64' }), 'linux-x64');

  assert.equal(editorPlatformKey({ platform: 'win32', arch: 'x64' }), null);
  assert.equal(editorPlatformKey({ platform: 'linux', arch: 'arm64' }), null);
  assert.equal(editorPlatformKey({ platform: 'freebsd', arch: 'x64' }), null);
});
