import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  mergeMacUpdateMetadata,
  parseMacUpdateYaml,
  serializeMacUpdateYaml,
  verifyMacArchitectureMetadata,
} from './macos-update-metadata.mjs';
import { mergeMacMetadataDirectories } from './merge-macos-update-metadata.mjs';

test('dual-architecture metadata merging is deterministic and keeps x64 legacy fields', () => {
  const fixture = createFixture();
  try {
    const x64 = verify(fixture, 'x64');
    const arm64 = verify(fixture, 'arm64');
    const first = serializeMacUpdateYaml(mergeMacUpdateMetadata({ arm64, x64 }));
    const second = serializeMacUpdateYaml(mergeMacUpdateMetadata({ arm64, x64 }));
    assert.equal(first, second);
    const merged = parseMacUpdateYaml(
      first.replace('files:', 'files:').replace(/  - url:/gu, '  - url:'),
    );
    assert.deepEqual(
      merged.files.map((file) => file.url),
      ['Isagi-mac-x64.zip', 'Isagi-mac-x64.dmg', 'Isagi-mac-arm64.zip', 'Isagi-mac-arm64.dmg'],
    );
    assert.equal(merged.path, 'Isagi-mac-x64.zip');
    assert.equal(merged.sha512, merged.files[0].sha512);
    assert.equal(merged.releaseDate, '2026-07-30T02:00:00.000Z');
  } finally {
    fixture.cleanup();
  }
});

test('architecture metadata rejects missing, duplicate, unexpected, and corrupt artifacts', () => {
  const fixture = createFixture();
  try {
    const valid = fixture.metadata('x64');
    assert.throws(
      () =>
        verifyContents(
          fixture,
          'x64',
          valid.replace(/  - url: Isagi-mac-x64.dmg[\s\S]*?size: \d+\n/u, ''),
        ),
      /exactly one ZIP and one DMG/u,
    );
    assert.throws(
      () => verifyContents(fixture, 'x64', valid.replace('Isagi-mac-x64.dmg', 'Isagi-mac-x64.zip')),
      /duplicate URL/u,
    );
    assert.throws(
      () => verifyContents(fixture, 'x64', valid.replace('Isagi-mac-x64.dmg', 'unexpected.pkg')),
      /must contain only/u,
    );
    assert.throws(
      () => verifyContents(fixture, 'x64', valid.replace('size: 7', 'size: 8')),
      /size does not match/u,
    );
    assert.throws(
      () =>
        verifyContents(
          fixture,
          'x64',
          valid.replace(fixture.sha('x64', 'zip'), Buffer.alloc(64).toString('base64')),
        ),
      /SHA-512 does not match/u,
    );
    assert.throws(
      () => verifyContents(fixture, 'x64', `${valid}unexpected: value\n`),
      /unexpected top-level/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test('metadata merge rejects version and shared release-fact mismatches', () => {
  const fixture = createFixture();
  try {
    const x64 = verify(fixture, 'x64');
    const arm64 = verify(fixture, 'arm64');
    assert.throws(
      () =>
        mergeMacUpdateMetadata({
          arm64: { ...arm64, metadata: { ...arm64.metadata, version: '1.2.4' } },
          x64,
        }),
      /version differs/u,
    );
    assert.throws(
      () =>
        mergeMacUpdateMetadata({
          arm64: { ...arm64, metadata: { ...arm64.metadata, minimumSystemVersion: '24' } },
          x64,
        }),
      /minimumSystemVersion differs/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test('directory merger validates both complete inputs before atomically writing output', () => {
  const fixture = createFixture();
  try {
    const outputPath = resolve(fixture.root, 'latest-mac.yml');
    mergeMacMetadataDirectories({
      arm64Directory: fixture.directories.arm64,
      outputPath,
      version: '1.2.3',
      x64Directory: fixture.directories.x64,
    });
    const contents = readFileSync(outputPath, 'utf8');
    assert.deepEqual(
      parseMacUpdateYaml(contents).files.map((file) => file.url),
      ['Isagi-mac-x64.zip', 'Isagi-mac-x64.dmg', 'Isagi-mac-arm64.zip', 'Isagi-mac-arm64.dmg'],
    );
    rmSync(resolve(fixture.directories.arm64, 'latest-mac.yml'));
    assert.throws(
      () =>
        mergeMacMetadataDirectories({
          arm64Directory: fixture.directories.arm64,
          outputPath,
          version: '1.2.3',
          x64Directory: fixture.directories.x64,
        }),
      /ENOENT/u,
    );
    assert.equal(readFileSync(outputPath, 'utf8'), contents);
  } finally {
    fixture.cleanup();
  }
});

function createFixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'isagi-mac-metadata-'));
  const directories = {};
  const records = {};
  for (const architecture of ['x64', 'arm64']) {
    const directory = resolve(root, architecture);
    mkdirSync(directory);
    directories[architecture] = directory;
    records[architecture] = {};
    for (const extension of ['zip', 'dmg']) {
      const name = `Isagi-mac-${architecture}.${extension}`;
      const bytes = Buffer.from(`${architecture}-${extension}`);
      writeFileSync(resolve(directory, name), bytes);
      writeFileSync(resolve(directory, `${name}.blockmap`), Buffer.alloc(42));
      records[architecture][extension] = {
        name,
        sha512: createHash('sha512').update(bytes).digest('base64'),
        size: bytes.length,
      };
    }
  }
  const fixture = {
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    directories,
    metadata: (architecture) => metadataYaml(records[architecture], architecture),
    records,
    root,
    sha: (architecture, extension) => records[architecture][extension].sha512,
  };
  for (const architecture of ['x64', 'arm64']) {
    writeFileSync(
      resolve(directories[architecture], 'latest-mac.yml'),
      fixture.metadata(architecture),
    );
  }
  return fixture;
}

function metadataYaml(records, architecture) {
  const releaseDate =
    architecture === 'x64' ? '2026-07-30T01:00:00.000Z' : '2026-07-30T02:00:00.000Z';
  return `version: 1.2.3
files:
  - url: ${records.zip.name}
    sha512: ${records.zip.sha512}
    size: ${records.zip.size}
    blockMapSize: 42
  - url: ${records.dmg.name}
    sha512: ${records.dmg.sha512}
    size: ${records.dmg.size}
path: ${records.zip.name}
sha512: ${records.zip.sha512}
releaseDate: '${releaseDate}'
`;
}

function verify(fixture, architecture) {
  return verifyContents(fixture, architecture, fixture.metadata(architecture));
}

function verifyContents(fixture, architecture, contents) {
  return verifyMacArchitectureMetadata({
    architecture,
    contents,
    directory: fixture.directories[architecture],
    version: '1.2.3',
  });
}
