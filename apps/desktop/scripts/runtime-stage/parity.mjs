import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';

import { StageValidationError } from './errors.mjs';

const requiredPayloadFiles = ['index.js', 'package.json', 'runtime-stage.json'];
const requiredPayloadDirectories = ['assets', 'drizzle'];

export function verifyRuntimeStageParity(sourceRoot, packagedRoot, platform = process.platform) {
  const sourceMetadata = readJson(resolve(sourceRoot, 'runtime-stage.json'));
  const packagedMetadata = readJson(resolve(packagedRoot, 'runtime-stage.json'));
  assertEqual(
    packagedRoot,
    'runtime-stage metadata differs from the canonical stage',
    stableJson(sourceMetadata),
    stableJson(packagedMetadata),
  );

  const sourceFiles = selectedPayloadFiles(sourceRoot);
  const packagedFiles = selectedPayloadFiles(packagedRoot);
  assertEqual(
    packagedRoot,
    'selected runtime layout differs from the canonical stage',
    stableJson(sourceFiles),
    stableJson(packagedFiles),
  );

  let executableFileCount = 0;
  for (const relativePath of sourceFiles) {
    const sourcePath = resolve(sourceRoot, relativePath);
    const packagedPath = resolve(packagedRoot, relativePath);
    assertEqual(
      packagedPath,
      'packaged byte hash differs from the canonical stage',
      sha256(sourcePath),
      sha256(packagedPath),
    );
    if (platform !== 'win32') {
      const sourceMode = lstatSync(sourcePath).mode & 0o777;
      const packagedMode = lstatSync(packagedPath).mode & 0o777;
      assertEqual(
        packagedPath,
        'packaged permission mode differs from the canonical stage',
        sourceMode,
        packagedMode,
      );
      if (basename(relativePath) === 'spawn-helper' && (sourceMode & 0o111) !== 0) {
        executableFileCount += 1;
        if ((packagedMode & 0o111) === 0) {
          fail(packagedPath, 'node-pty spawn-helper is not executable');
        }
      }
    }
  }
  if (!sourceFiles.some((path) => path.endsWith('.node'))) {
    fail(sourceRoot, 'selected parity payload contains no native modules');
  }
  if (platform === 'darwin' && executableFileCount === 0) {
    fail(sourceRoot, 'selected parity payload contains no executable macOS node-pty helper');
  }

  return {
    byteFileCount: sourceFiles.length,
    dependencyVersions: sourceMetadata.dependencyVersions,
    electron: sourceMetadata.electron,
    executableFileCount,
  };
}

function selectedPayloadFiles(root) {
  const selected = [...requiredPayloadFiles];
  for (const directory of requiredPayloadDirectories) {
    selected.push(...walkFiles(resolve(root, directory)).map((path) => relative(root, path)));
  }
  selected.push(
    ...walkFiles(resolve(root, 'node_modules'))
      .filter((path) => path.endsWith('.node') || basename(path) === 'spawn-helper')
      .map((path) => relative(root, path)),
  );
  return [...new Set(selected.map(normalizePath))].sort();
}

function walkFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function normalizePath(path) {
  return sep === '/' ? path : path.split(sep).join('/');
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    fail(path, `could not read parity metadata: ${errorMessage(cause)}`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertEqual(path, reason, expected, actual) {
  if (expected !== actual) fail(path, reason);
}

function fail(path, reason) {
  throw new StageValidationError({ path, reason });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
