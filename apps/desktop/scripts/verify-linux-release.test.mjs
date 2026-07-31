import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  decodePngDimensions,
  linuxReleaseContract,
  parseLatestLinuxYaml,
  verifyElfPayloads,
  verifyEmbeddedBlockmap,
  verifyLatestLinuxMetadata,
  verifyPublishableAssetSet,
} from './verify-linux-release.mjs';

test('Linux release contract pins stable assets, zstd, and the complete documented icon set', () => {
  assert.deepEqual(linuxReleaseContract, {
    appImageName: 'Isagi-linux-x86_64.AppImage',
    compression: 'zstd',
    desktopName: 'studio.yourtechbud.isagi.desktop',
    iconSizes: [16, 24, 32, 48, 64, 96, 128, 256, 512],
    installerName: 'install-isagi-linux.sh',
    metadataName: 'latest-linux.yml',
    provider: { owner: 'YourTechBudStudio', provider: 'github', repo: 'Isagi' },
  });
});

test('electron-builder configuration pins the AppImage distribution boundary', async () => {
  const configuration = await readFile(
    resolve(import.meta.dirname, '../electron-builder.yml'),
    'utf8',
  );
  for (const expected of [
    "appimage: '1.0.3'",
    'artifactName: Isagi-linux-x86_64.${ext}',
    'target: AppImage',
    'compression: zstd',
    'provider: github',
    'owner: YourTechBudStudio',
    'repo: Isagi',
    'StartupWMClass: studio.yourtechbud.isagi',
  ]) {
    assert.equal(configuration.includes(expected), true, `missing ${expected}`);
  }
  assert.equal(configuration.includes('--no-sandbox'), false);
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
  );
  assert.equal('dist' in manifest.scripts, false);
  assert.equal(
    manifest.scripts['dist:linux'],
    'node scripts/run-electron-builder.mjs --linux AppImage --x64 --publish never',
  );
});

test('latest-linux parser and verifier require exact metadata integrity and embedded blockmap facts', () => {
  const embedded = embeddedBlockmap();
  const appImage = embedded.bytes;
  const sha512 = createHash('sha512').update(appImage).digest('base64');
  const manifest = parseLatestLinuxYaml(`version: 1.2.3
files:
  - url: Isagi-linux-x86_64.AppImage
    sha512: ${sha512}
    size: ${appImage.byteLength}
    blockMapSize: ${embedded.blockMapSize}
path: Isagi-linux-x86_64.AppImage
sha512: ${sha512}
releaseDate: '2026-07-30T00:00:00.000Z'
`);
  verifyLatestLinuxMetadata(manifest, appImage, '1.2.3');
  assert.equal(manifest.files[0].blockMapSize, embedded.blockMapSize);
  assert.throws(
    () => verifyLatestLinuxMetadata({ ...manifest, version: '1.2.4' }, appImage, '1.2.3'),
    /does not match/u,
  );
  assert.throws(
    () =>
      verifyLatestLinuxMetadata(
        { ...manifest, files: [{ ...manifest.files[0], size: appImage.byteLength + 1 }] },
        appImage,
        '1.2.3',
      ),
    /size/u,
  );
  assert.throws(
    () =>
      verifyLatestLinuxMetadata(
        { ...manifest, files: [{ ...manifest.files[0], blockMapSize: 0 }] },
        appImage,
        '1.2.3',
      ),
    /blockMapSize/u,
  );
});

test('embedded blockmap verification pins its trailer, raw-deflate structure, and complete coverage', () => {
  const valid = embeddedBlockmap();
  assert.deepEqual(verifyEmbeddedBlockmap(valid.bytes, valid.blockMapSize), {
    blockMapStart: valid.payloadSize,
    chunkCount: 2,
  });
  assert.throws(
    () => verifyEmbeddedBlockmap(valid.bytes, valid.blockMapSize + 1),
    /does not match metadata/u,
  );

  const truncated = Buffer.from(valid.bytes);
  truncated.writeUInt32BE(truncated.length, truncated.length - 4);
  assert.throws(() => verifyEmbeddedBlockmap(truncated, truncated.length), /outside the AppImage/u);

  const corruptDeflate = Buffer.from(valid.bytes);
  corruptDeflate[valid.payloadSize] ^= 0xff;
  assert.throws(
    () => verifyEmbeddedBlockmap(corruptDeflate, valid.blockMapSize),
    /raw-deflate JSON/u,
  );

  const malformedJson = embeddedPayload(Buffer.from('{'));
  assert.throws(
    () => verifyEmbeddedBlockmap(malformedJson.bytes, malformedJson.blockMapSize),
    /raw-deflate JSON/u,
  );

  for (const blockMap of [
    { version: '1', files: [] },
    { version: '2', files: [] },
    blockMapRecord({ name: 'wrong' }),
    blockMapRecord({ offset: 1 }),
    blockMapRecord({ checksums: [] }),
    blockMapRecord({ sizes: [valid.payloadSize] }),
    blockMapRecord({ sizes: [0, valid.payloadSize] }),
    blockMapRecord({ sizes: [1, 1] }),
    blockMapRecord({ checksums: ['not base64', canonicalChecksum()] }),
    blockMapRecord({ checksums: [Buffer.alloc(17).toString('base64'), canonicalChecksum()] }),
  ]) {
    const malformed = embeddedBlockmap(blockMap);
    assert.throws(() => verifyEmbeddedBlockmap(malformed.bytes, malformed.blockMapSize));
  }
});

test('Linux release directory accepts only the exact required outputs and optional diagnostics', async () => {
  const releaseDirectory = await mkdtemp(resolve(tmpdir(), 'isagi-release-allowlist-'));
  try {
    await writeFile(resolve(releaseDirectory, 'Isagi-linux-x86_64.AppImage'), 'app');
    await writeFile(resolve(releaseDirectory, 'latest-linux.yml'), 'metadata');
    await writeFile(resolve(releaseDirectory, 'install-isagi-linux.sh'), 'installer');
    await mkdir(resolve(releaseDirectory, 'linux-unpacked'));
    verifyPublishableAssetSet(releaseDirectory);
    await writeFile(resolve(releaseDirectory, 'builder-debug.yml'), 'diagnostic');
    await writeFile(resolve(releaseDirectory, 'builder-effective-config.yaml'), 'diagnostic');
    verifyPublishableAssetSet(releaseDirectory);

    await writeFile(resolve(releaseDirectory, 'unexpected.deb'), 'package');
    assert.throws(() => verifyPublishableAssetSet(releaseDirectory), /unexpected/u);
    await rm(resolve(releaseDirectory, 'unexpected.deb'));
    await writeFile(resolve(releaseDirectory, '.hidden'), 'hidden');
    assert.throws(() => verifyPublishableAssetSet(releaseDirectory), /unexpected/u);
    await rm(resolve(releaseDirectory, '.hidden'));
    await mkdir(resolve(releaseDirectory, 'unexpected-directory'));
    assert.throws(() => verifyPublishableAssetSet(releaseDirectory), /unexpected/u);
    await rm(resolve(releaseDirectory, 'unexpected-directory'), { recursive: true });

    await rm(resolve(releaseDirectory, 'latest-linux.yml'));
    assert.throws(() => verifyPublishableAssetSet(releaseDirectory), /missing/u);
    await symlink('builder-debug.yml', resolve(releaseDirectory, 'latest-linux.yml'));
    assert.throws(() => verifyPublishableAssetSet(releaseDirectory), /symlink/u);
    await rm(resolve(releaseDirectory, 'latest-linux.yml'));
    await rm(resolve(releaseDirectory, 'linux-unpacked'), { recursive: true });
    await symlink('.', resolve(releaseDirectory, 'linux-unpacked'));
    assert.throws(() => verifyPublishableAssetSet(releaseDirectory), /symlink/u);
  } finally {
    await rm(releaseDirectory, { recursive: true, force: true });
  }
});

test('PNG verification inflates image data before accepting decoded dimensions', () => {
  const icon = readFileSync(resolve(import.meta.dirname, '../assets/app-icon-linux.png'));
  assert.deepEqual(decodePngDimensions(icon), { height: 1200, width: 1200 });
  const corrupted = Buffer.from(icon);
  const idat = corrupted.indexOf(Buffer.from('IDAT'));
  assert.notEqual(idat, -1);
  corrupted[idat + 8] ^= 0xff;
  assert.throws(() => decodePngDimensions(corrupted));
});

test('latest-linux parser rejects incomplete and structurally surprising input', () => {
  assert.throws(() => parseLatestLinuxYaml('version: 1.2.3\nfiles:\n'), /missing path/u);
  assert.throws(
    () => parseLatestLinuxYaml('version: 1.2.3\n  surprising: value\n'),
    /Unsupported/u,
  );
});

test('ELF payload scanning covers every packaged binary and rejects a mismatched helper', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'isagi-elf-payloads-'));
  try {
    await mkdir(resolve(root, 'resources/runtime/node_modules/node-pty/build'), {
      recursive: true,
    });
    const payloads = [
      'isagi',
      'chrome_crashpad_handler',
      'chrome-sandbox',
      'libffmpeg.so',
      'resources/runtime/node_modules/node-pty/build/pty.node',
      'resources/runtime/node_modules/node-pty/build/spawn-helper',
    ];
    for (const payload of payloads) await writeFile(resolve(root, payload), elfHeader());
    // Non-ELF and short files are skipped rather than treated as binaries.
    await writeFile(resolve(root, 'resources/app.asar'), 'not an executable');
    await writeFile(resolve(root, 'version'), 'v43');
    assert.deepEqual(
      verifyElfPayloads(root)
        .map((path) => path.slice(root.length + 1))
        .sort(),
      [...payloads].sort(),
    );

    const helper = resolve(root, 'chrome_crashpad_handler');
    await writeFile(helper, elfHeader({ machine: 0xb7 }));
    assert.throws(() => verifyElfPayloads(root), /chrome_crashpad_handler is not x86-64 ELF/u);
    await writeFile(helper, elfHeader({ elfClass: 1 }));
    assert.throws(() => verifyElfPayloads(root), /chrome_crashpad_handler is not a 64-bit ELF/u);
    await writeFile(helper, elfHeader({ endianness: 2 }));
    assert.throws(
      () => verifyElfPayloads(root),
      /chrome_crashpad_handler is not a little-endian ELF/u,
    );
    await writeFile(helper, elfHeader().subarray(0, 12));
    assert.throws(() => verifyElfPayloads(root), /chrome_crashpad_handler is not an ELF/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function elfHeader({ elfClass = 2, endianness = 1, machine = 0x3e } = {}) {
  const header = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header);
  header[4] = elfClass;
  header[5] = endianness;
  header.writeUInt16LE(2, 16);
  header.writeUInt16LE(machine, 18);
  return header;
}

function embeddedBlockmap(blockMap) {
  const payload = Buffer.alloc(64, 0x49);
  const value = blockMap ?? blockMapRecord({ sizes: [21, payload.length - 21] });
  return embeddedPayload(Buffer.from(JSON.stringify(value)), payload);
}

function embeddedPayload(blockMapJson, payload = Buffer.alloc(64, 0x49)) {
  const compressed = deflateRawSync(blockMapJson);
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(compressed.length);
  return {
    blockMapSize: compressed.length,
    bytes: Buffer.concat([payload, compressed, trailer]),
    payloadSize: payload.length,
  };
}

function blockMapRecord(overrides = {}) {
  return {
    version: '2',
    files: [
      {
        name: 'file',
        offset: 0,
        checksums: [canonicalChecksum(), Buffer.alloc(18, 2).toString('base64')],
        sizes: [21, 43],
        ...overrides,
      },
    ],
  };
}

function canonicalChecksum() {
  return Buffer.alloc(18, 1).toString('base64');
}
