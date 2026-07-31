import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export const releaseManifestName = 'release-manifest.json';

const requiredAssetNames = Object.freeze([
  'Isagi-linux-x86_64.AppImage',
  'install-isagi-linux.sh',
  'latest-linux.yml',
  'Isagi-mac-x64.dmg',
  'Isagi-mac-x64.zip',
  'Isagi-mac-arm64.dmg',
  'Isagi-mac-arm64.zip',
  'latest-mac.yml',
]);

const optionalAssetNames = Object.freeze(
  ['x64', 'arm64'].flatMap((architecture) =>
    ['dmg', 'zip'].map((extension) => `Isagi-mac-${architecture}.${extension}.blockmap`),
  ),
);

export function expectedPlatformFiles(platform) {
  if (platform === 'linux') return requiredAssetNames.slice(0, 3);
  if (platform === 'mac-x64') {
    return ['Isagi-mac-x64.dmg', 'Isagi-mac-x64.zip', 'latest-mac.yml'];
  }
  if (platform === 'mac-arm64') {
    return ['Isagi-mac-arm64.dmg', 'Isagi-mac-arm64.zip', 'latest-mac.yml'];
  }
  throw new Error(`Unsupported release platform ${platform}.`);
}

export function validatePlatformDirectory(directory, platform) {
  const required = new Set(expectedPlatformFiles(platform));
  const architecture = platform.startsWith('mac-') ? platform.slice('mac-'.length) : undefined;
  const optional = new Set(
    architecture ? optionalAssetNames.filter((name) => name.includes(`-${architecture}.`)) : [],
  );
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!required.has(entry.name) && !optional.has(entry.name)) {
      throw new Error(`${platform} artifact contains unexpected entry ${entry.name}.`);
    }
    const metadata = lstatSync(resolve(directory, entry.name));
    if (!entry.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`${platform} artifact entry ${entry.name} is not a regular file.`);
    }
  }
  const names = new Set(entries.map((entry) => entry.name));
  for (const name of required) {
    if (!names.has(name)) throw new Error(`${platform} artifact is missing ${name}.`);
  }
  return [...names].sort();
}

export function createReleaseManifest({ directory, version, tag, commitSha }) {
  const names = readdirSync(directory)
    .filter((name) => name !== releaseManifestName)
    .sort();
  validateAggregateNames(names);
  return {
    schemaVersion: 1,
    version,
    tag,
    commitSha,
    assets: names.map((name) => fileRecord(resolve(directory, name))),
  };
}

export function serializeReleaseManifest(manifest) {
  validateReleaseManifest(manifest);
  return `${JSON.stringify(manifest, undefined, 2)}\n`;
}

export function readAndVerifyReleaseManifest(directory, expected = {}) {
  const path = resolve(directory, releaseManifestName);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  validateReleaseManifest(manifest, expected);
  const actualNames = readdirSync(directory)
    .filter((name) => name !== releaseManifestName)
    .sort();
  const declaredNames = manifest.assets.map((asset) => asset.name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(declaredNames)) {
    throw new Error('Downloaded aggregate differs from the closed release manifest.');
  }
  for (const asset of manifest.assets) {
    const actual = fileRecord(resolve(directory, asset.name));
    if (actual.size !== asset.size || actual.sha256 !== asset.sha256) {
      throw new Error(`Release asset ${asset.name} does not match its declared size and SHA-256.`);
    }
  }
  return manifest;
}

export function validateReleaseManifest(manifest, expected = {}) {
  if (!manifest || manifest.schemaVersion !== 1) throw new Error('Unsupported release manifest.');
  if (Object.keys(manifest).sort().join(',') !== 'assets,commitSha,schemaVersion,tag,version') {
    throw new Error('Release manifest contains unsupported top-level fields.');
  }
  for (const key of ['version', 'tag', 'commitSha']) {
    if (typeof manifest[key] !== 'string' || manifest[key].length === 0) {
      throw new Error(`Release manifest ${key} is missing.`);
    }
    if (expected[key] !== undefined && manifest[key] !== expected[key]) {
      throw new Error(`Release manifest ${key} does not match the classified release.`);
    }
  }
  if (!Array.isArray(manifest.assets)) throw new Error('Release manifest assets are missing.');
  const names = manifest.assets.map((asset) => asset?.name);
  validateAggregateNames(names);
  if (JSON.stringify(names) !== JSON.stringify([...names].sort())) {
    throw new Error('Release manifest assets are not in canonical name order.');
  }
  for (const asset of manifest.assets) {
    if (
      Object.keys(asset).sort().join(',') !== 'name,sha256,size' ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0 ||
      !/^[a-f0-9]{64}$/u.test(asset.sha256)
    ) {
      throw new Error(`Release manifest asset ${asset?.name ?? '(missing)'} is malformed.`);
    }
  }
}

export function publishedAssetRecords(manifest) {
  return [
    ...manifest.assets,
    {
      name: releaseManifestName,
      size: Buffer.byteLength(serializeReleaseManifest(manifest)),
      sha256: createHash('sha256').update(serializeReleaseManifest(manifest)).digest('hex'),
    },
  ].sort((left, right) => left.name.localeCompare(right.name));
}

function validateAggregateNames(names) {
  if (names.some((name) => typeof name !== 'string' || basename(name) !== name)) {
    throw new Error('Release manifest contains an unsafe asset name.');
  }
  const unique = new Set(names);
  if (unique.size !== names.length) throw new Error('Release manifest contains duplicate assets.');
  for (const name of requiredAssetNames) {
    if (!unique.has(name)) throw new Error(`Release aggregate is missing ${name}.`);
  }
  const allowed = new Set([...requiredAssetNames, ...optionalAssetNames]);
  for (const name of unique) {
    if (!allowed.has(name)) throw new Error(`Release aggregate contains unexpected asset ${name}.`);
  }
}

function fileRecord(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Release asset ${basename(path)} is not a regular file.`);
  }
  return {
    name: basename(path),
    size: metadata.size,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}
