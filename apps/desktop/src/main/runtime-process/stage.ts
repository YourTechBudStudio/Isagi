import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve, sep } from 'node:path';
import process from 'node:process';

import { Data } from 'effect';

interface RuntimeStageMetadata {
  readonly dependencyVersions: Readonly<Record<string, string>>;
  readonly electron: {
    readonly abi: string;
    readonly arch: string;
    readonly node: string;
    readonly platform: string;
    readonly version: string;
  };
  readonly entrypoint: string;
  readonly fingerprint: string;
  readonly layoutVersion: 1;
}

export interface ValidatedRuntimeStage {
  readonly entrypoint: string;
  readonly root: string;
  readonly metadata: RuntimeStageMetadata;
}

export class RuntimeStageValidationError extends Data.TaggedError('RuntimeStageValidationError')<{
  readonly path: string;
  readonly reason: string;
}> {
  override get message() {
    return `Runtime stage validation failed at ${this.path}: ${this.reason}`;
  }
}

export function validateRuntimeStage(root: string): ValidatedRuntimeStage {
  const metadataPath = resolve(root, 'runtime-stage.json');
  const metadata = readMetadata(metadataPath);
  const required = [
    metadata.entrypoint,
    'assets/manifest.json',
    'drizzle/meta/_journal.json',
    'package.json',
  ];
  for (const relativePath of required) requireFile(root, relativePath);

  if (metadata.layoutVersion !== 1) fail(metadataPath, 'unsupported layoutVersion');
  if (metadata.entrypoint !== 'index.js') fail(metadataPath, 'entrypoint must be index.js');
  if (!metadata.fingerprint) fail(metadataPath, 'fingerprint is missing');
  assertElectronContext(metadataPath, metadata);
  assertDependencyClosure(root, metadata);
  assertMetadataContainsNoAbsolutePaths(metadataPath, metadata);

  return { entrypoint: resolve(root, metadata.entrypoint), root, metadata };
}

function readMetadata(path: string): RuntimeStageMetadata {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    fail(path, `metadata could not be read: ${errorMessage(cause)}`);
  }
  if (!isRecord(value)) fail(path, 'metadata must be an object');
  if (!isRecord(value.dependencyVersions)) fail(path, 'dependencyVersions must be an object');
  for (const [name, version] of Object.entries(value.dependencyVersions)) {
    if (!name || typeof version !== 'string' || !version) {
      fail(path, 'dependencyVersions must contain non-empty string versions');
    }
  }
  if (!isRecord(value.electron)) fail(path, 'electron metadata must be an object');
  for (const field of ['abi', 'arch', 'node', 'platform', 'version'] as const) {
    if (typeof value.electron[field] !== 'string' || !value.electron[field]) {
      fail(path, `electron.${field} must be a non-empty string`);
    }
  }
  if (typeof value.entrypoint !== 'string') fail(path, 'entrypoint must be a string');
  if (typeof value.fingerprint !== 'string') fail(path, 'fingerprint must be a string');
  if (value.layoutVersion !== 1) fail(path, 'layoutVersion must be 1');
  return value as unknown as RuntimeStageMetadata;
}

function assertElectronContext(path: string, metadata: RuntimeStageMetadata) {
  const actual = {
    abi: process.versions.modules,
    arch: process.arch,
    node: process.version,
    platform: process.platform,
    version: process.versions.electron,
  };
  for (const field of ['abi', 'arch', 'node', 'platform', 'version'] as const) {
    if (actual[field] !== metadata.electron[field]) {
      fail(
        path,
        `Electron ${field} ${String(actual[field])} does not match staged ${metadata.electron[field]}`,
      );
    }
  }
}

function assertDependencyClosure(root: string, metadata: RuntimeStageMetadata) {
  const manifestPath = resolve(root, 'package.json');
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (cause) {
    fail(manifestPath, `manifest could not be read: ${errorMessage(cause)}`);
  }
  if (!isRecord(manifest) || !isRecord(manifest.dependencies)) {
    fail(manifestPath, 'dependencies must be an object');
  }
  if (stableJson(manifest.dependencies) !== stableJson(metadata.dependencyVersions)) {
    fail(manifestPath, 'dependencies do not match runtime-stage.json');
  }

  const anchoredRequire = createRequire(manifestPath);
  for (const dependency of Object.keys(metadata.dependencyVersions)) {
    let resolved: string;
    try {
      resolved = realpathSync(anchoredRequire.resolve(dependency));
    } catch (cause) {
      fail(manifestPath, `${dependency} cannot be resolved: ${errorMessage(cause)}`);
    }
    if (!isWithin(root, resolved)) fail(resolved, `${dependency} resolves outside the stage`);
  }

  for (const nativePackage of ['better-sqlite3', 'node-pty']) {
    const packageRoot = resolve(root, 'node_modules', nativePackage);
    if (!(nativePackage in metadata.dependencyVersions)) continue;
    if (!containsNativeArtifact(packageRoot)) fail(packageRoot, 'native .node artifact is missing');
  }
}

function containsNativeArtifact(root: string): boolean {
  if (!existsSync(root)) return false;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isFile() && entry.name.endsWith('.node')) return true;
    if (entry.isDirectory() && containsNativeArtifact(path)) return true;
  }
  return false;
}

function assertMetadataContainsNoAbsolutePaths(path: string, value: unknown) {
  const visit = (candidate: unknown) => {
    if (typeof candidate === 'string' && isAbsolute(candidate)) {
      fail(path, `metadata contains absolute path ${candidate}`);
    }
    if (Array.isArray(candidate)) candidate.forEach(visit);
    else if (isRecord(candidate)) Object.values(candidate).forEach(visit);
  };
  visit(value);
}

function requireFile(root: string, relativePath: string) {
  const path = resolve(root, relativePath);
  if (!isWithin(root, path) || !existsSync(path))
    fail(path, `required file ${relativePath} is missing`);
}

function isWithin(root: string, path: string) {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, reason: string): never {
  throw new RuntimeStageValidationError({ path, reason });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
