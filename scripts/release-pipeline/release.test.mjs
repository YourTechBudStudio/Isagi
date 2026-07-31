import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { aggregateRelease, validatePlatformDirectory } from './aggregate-release.mjs';

test('aggregation collects the platform outputs and merges macOS update metadata', () => {
  const fixture = createAggregateFixture();
  try {
    assert.deepEqual(aggregateRelease(fixture.options), [
      'Isagi-linux-x86_64.AppImage',
      'Isagi-mac-arm64.dmg',
      'Isagi-mac-arm64.zip',
      'Isagi-mac-x64.dmg',
      'Isagi-mac-x64.zip',
      'install-isagi-linux.sh',
      'latest-linux.yml',
      'latest-mac.yml',
    ]);
    const metadata = readFileSync(resolve(fixture.output, 'latest-mac.yml'), 'utf8');
    assert.match(metadata, /Isagi-mac-arm64/u);
    assert.match(metadata, /Isagi-mac-x64/u);
  } finally {
    fixture.cleanup();
  }
});

test('platform artifact validation rejects missing, unexpected, and symlinked handoffs', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'isagi-release-platform-'));
  try {
    for (const name of [
      'Isagi-linux-x86_64.AppImage',
      'install-isagi-linux.sh',
      'latest-linux.yml',
    ]) {
      writeFileSync(resolve(root, name), name);
    }
    assert.equal(validatePlatformDirectory(root, 'linux').length, 3);
    writeFileSync(resolve(root, 'unexpected'), 'no');
    assert.throws(() => validatePlatformDirectory(root, 'linux'), /unexpected entry/u);
    rmSync(resolve(root, 'unexpected'));
    rmSync(resolve(root, 'latest-linux.yml'));
    assert.throws(() => validatePlatformDirectory(root, 'linux'), /missing latest-linux/u);
    symlinkSync(resolve(root, 'install-isagi-linux.sh'), resolve(root, 'latest-linux.yml'));
    assert.throws(() => validatePlatformDirectory(root, 'linux'), /not a regular file/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('release workflow builds once after publication and attaches the collected assets', () => {
  const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /on:\n  release:\n    types: \[published\]/u);
  assert.doesNotMatch(workflow, /push:\n    tags:|prerelease|promote|reconcile|release-manifest/u);
  for (const use of workflow.matchAll(/uses:\s+([^\s#]+)/gu)) {
    assert.match(use[1], /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/u);
  }
  assert.equal(workflow.match(/^    environment: Production$/gmu)?.length, 2);
  assert.equal(workflow.match(/contents: write/gu)?.length, 1);
  assert.equal(workflow.match(/ref: \$\{\{ github\.event\.release\.tag_name \}\}/gu)?.length, 4);
  assert.match(
    workflow,
    /attach_assets:\n    name: Attach release assets\n    needs: \[linux, mac_arm64, mac_x64\]\n/u,
  );
  assert.match(workflow, /run: gh release upload "\$RELEASE_TAG" release-assets\/\* --clobber/u);
  assert.doesNotMatch(workflow, /^  (?:classify|finalize|reconcile|publish|aggregate):$/gmu);
});

function createAggregateFixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'isagi-release-aggregate-'));
  const linux = resolve(root, 'linux');
  const x64 = resolve(root, 'mac-x64');
  const arm64 = resolve(root, 'mac-arm64');
  const output = resolve(root, 'output');
  for (const directory of [linux, x64, arm64]) mkdirSync(directory, { recursive: true });
  for (const name of [
    'Isagi-linux-x86_64.AppImage',
    'install-isagi-linux.sh',
    'latest-linux.yml',
  ]) {
    writeFileSync(resolve(linux, name), name);
  }
  createMacInput(x64, 'x64');
  createMacInput(arm64, 'arm64');
  return {
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    options: {
      linuxDirectory: linux,
      macArm64Directory: arm64,
      macX64Directory: x64,
      outputDirectory: output,
      version: '1.2.3',
    },
    output,
  };
}

function createMacInput(directory, architecture) {
  const records = [];
  for (const extension of ['zip', 'dmg']) {
    const name = `Isagi-mac-${architecture}.${extension}`;
    const contents = Buffer.from(`${architecture}-${extension}`);
    writeFileSync(resolve(directory, name), contents);
    records.push({
      name,
      sha512: createHash('sha512').update(contents).digest('base64'),
      size: contents.length,
    });
  }
  writeFileSync(
    resolve(directory, 'latest-mac.yml'),
    `version: 1.2.3\nfiles:\n${records.map((record) => `  - url: ${record.name}\n    sha512: ${record.sha512}\n    size: ${record.size}`).join('\n')}\npath: ${records[0].name}\nsha512: ${records[0].sha512}\nreleaseDate: '2026-07-30T00:00:00.000Z'\n`,
  );
}
