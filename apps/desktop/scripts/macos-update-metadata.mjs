import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { macReleaseContract } from './macos-release-contract.mjs';

const topLevelKeys = new Set([
  'version',
  'files',
  'path',
  'sha512',
  'releaseDate',
  'releaseName',
  'releaseNotes',
  'stagingPercentage',
  'minimumSystemVersion',
]);
const fileKeys = new Set(['url', 'sha512', 'size', 'blockMapSize']);
const sharedKeys = [
  'version',
  'releaseName',
  'releaseNotes',
  'stagingPercentage',
  'minimumSystemVersion',
];

export function parseMacUpdateYaml(contents) {
  const result = { files: [] };
  let currentFile;
  for (const rawLine of contents.split(/\r?\n/u)) {
    if (/^\s*(?:#.*)?$/u.test(rawLine)) continue;
    const fileStart = /^\s{2}-\s+([A-Za-z][\w-]*):\s*(.*?)\s*$/u.exec(rawLine);
    if (fileStart) {
      currentFile = {};
      result.files.push(currentFile);
      setKnown(currentFile, fileStart[1], yamlScalar(fileStart[2]), fileKeys, 'file');
      continue;
    }
    const nested = /^\s{4}([A-Za-z][\w-]*):\s*(.*?)\s*$/u.exec(rawLine);
    if (nested && currentFile) {
      setKnown(currentFile, nested[1], yamlScalar(nested[2]), fileKeys, 'file');
      continue;
    }
    const top = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/u.exec(rawLine);
    if (top) {
      currentFile = undefined;
      if (top[1] !== 'files') {
        setKnown(result, top[1], yamlScalar(top[2]), topLevelKeys, 'top-level');
      } else if (top[2] !== '') {
        fail('files must be a block sequence.');
      }
      continue;
    }
    fail(`unsupported latest-mac.yml line: ${rawLine}`);
  }
  for (const key of ['version', 'path', 'sha512', 'releaseDate']) {
    if (!(key in result)) fail(`latest-mac.yml is missing ${key}.`);
  }
  if (!Array.isArray(result.files) || result.files.length === 0)
    fail('latest-mac.yml has no files.');
  return result;
}

export function verifyMacArchitectureMetadata({ architecture, contents, directory, version }) {
  if (!macReleaseContract.architectures.includes(architecture)) {
    fail(`unsupported macOS metadata architecture ${architecture}.`);
  }
  const metadata = parseMacUpdateYaml(contents);
  if (metadata.files.length !== 2) {
    fail('each architecture metadata file must describe exactly one ZIP and one DMG.');
  }
  if (metadata.version !== version) {
    fail(`latest-mac.yml version ${metadata.version} does not match ${version}.`);
  }
  if (!isIsoDate(metadata.releaseDate))
    fail('latest-mac.yml releaseDate must be an ISO timestamp.');

  const expectedNames = ['zip', 'dmg'].map((extension) =>
    macReleaseContract.artifactName(architecture, extension),
  );
  const byUrl = new Map();
  for (const file of metadata.files) {
    verifyFileRecord(file);
    if (byUrl.has(file.url)) fail(`latest-mac.yml contains duplicate URL ${file.url}.`);
    byUrl.set(file.url, file);
  }
  if (byUrl.size !== expectedNames.length || expectedNames.some((name) => !byUrl.has(name))) {
    fail(`latest-mac.yml must contain only ${expectedNames.join(' and ')}.`);
  }
  for (const name of expectedNames) {
    verifyLocalArtifact(resolve(directory, name), byUrl.get(name));
    const file = byUrl.get(name);
    const blockmapPath = resolve(directory, `${name}.blockmap`);
    if (file.blockMapSize !== undefined) {
      const blockmap = lstatSync(blockmapPath);
      if (!blockmap.isFile() || blockmap.isSymbolicLink() || blockmap.size !== file.blockMapSize) {
        fail(`${name}.blockmap does not match latest-mac.yml blockMapSize.`);
      }
    }
  }
  const zipName = macReleaseContract.artifactName(architecture, 'zip');
  const zip = byUrl.get(zipName);
  if (metadata.path !== zipName || metadata.sha512 !== zip.sha512) {
    fail(`latest-mac.yml legacy path and SHA-512 must point to ${zipName}.`);
  }
  return { architecture, metadata, orderedFiles: expectedNames.map((name) => byUrl.get(name)) };
}

export function mergeMacUpdateMetadata({ arm64, x64 }) {
  for (const key of sharedKeys) {
    if (stableJson(x64.metadata[key]) !== stableJson(arm64.metadata[key])) {
      fail(`macOS metadata ${key} differs between x64 and arm64.`);
    }
  }
  const releaseDate = [x64.metadata.releaseDate, arm64.metadata.releaseDate].sort().at(-1);
  const files = [...x64.orderedFiles, ...arm64.orderedFiles].map((file) => ({ ...file }));
  const x64Zip = files[0];
  const merged = {
    version: x64.metadata.version,
    files,
    path: x64Zip.url,
    sha512: x64Zip.sha512,
    releaseDate,
  };
  for (const key of sharedKeys.slice(1)) {
    if (x64.metadata[key] !== undefined) merged[key] = x64.metadata[key];
  }
  return merged;
}

export function serializeMacUpdateYaml(metadata) {
  const lines = [`version: ${yamlString(metadata.version)}`, 'files:'];
  for (const file of metadata.files) {
    lines.push(`  - url: ${yamlString(file.url)}`);
    lines.push(`    sha512: ${yamlString(file.sha512)}`);
    lines.push(`    size: ${file.size}`);
    if (file.blockMapSize !== undefined) lines.push(`    blockMapSize: ${file.blockMapSize}`);
  }
  lines.push(`path: ${yamlString(metadata.path)}`);
  lines.push(`sha512: ${yamlString(metadata.sha512)}`);
  for (const key of [
    'releaseDate',
    'releaseName',
    'releaseNotes',
    'stagingPercentage',
    'minimumSystemVersion',
  ]) {
    if (metadata[key] !== undefined) lines.push(`${key}: ${yamlString(metadata[key])}`);
  }
  return `${lines.join('\n')}\n`;
}

function verifyFileRecord(file) {
  for (const key of ['url', 'sha512', 'size']) {
    if (!(key in file)) fail(`latest-mac.yml file record is missing ${key}.`);
  }
  if (basename(file.url) !== file.url || file.url.includes('..')) {
    fail(`latest-mac.yml URL must be a local artifact name: ${file.url}.`);
  }
  if (!isCanonicalSha512(file.sha512))
    fail(`latest-mac.yml has an invalid SHA-512 for ${file.url}.`);
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    fail(`latest-mac.yml has an invalid size for ${file.url}.`);
  }
  if (
    file.blockMapSize !== undefined &&
    (!Number.isSafeInteger(file.blockMapSize) || file.blockMapSize <= 0)
  ) {
    fail(`latest-mac.yml has an invalid blockMapSize for ${file.url}.`);
  }
}

function verifyLocalArtifact(path, file) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    fail(`${path} is not a regular artifact file.`);
  if (metadata.size !== file.size) fail(`${file.url} size does not match latest-mac.yml.`);
  const digest = createHash('sha512').update(readFileSync(path)).digest('base64');
  if (digest !== file.sha512) fail(`${file.url} SHA-512 does not match latest-mac.yml.`);
}

function setKnown(target, key, value, known, scope) {
  if (!known.has(key)) fail(`unexpected ${scope} latest-mac.yml key ${key}.`);
  if (key in target) fail(`duplicate ${scope} latest-mac.yml key ${key}.`);
  target[key] = value;
}

function yamlScalar(value) {
  const trimmed = value.trim();
  if (/^'.*'$/u.test(trimmed)) return trimmed.slice(1, -1).replaceAll("''", "'");
  if (/^".*"$/u.test(trimmed)) return JSON.parse(trimmed);
  if (/^\d+$/u.test(trimmed)) return Number(trimmed);
  if (trimmed === 'null') return null;
  return trimmed;
}

function yamlString(value) {
  if (typeof value === 'number') return String(value);
  if (value === null) return 'null';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function isCanonicalSha512(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function stableJson(value) {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fail(message) {
  throw new Error(message);
}
