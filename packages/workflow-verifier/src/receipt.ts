import { createHash } from 'node:crypto';

export const workflowBuildManifestVersion = 1 as const;
export const supportedWorkflowContractVersion = 1 as const;
export const workflowSdkPackage = '@yourtechbudstudio/isagi-workflow-sdk' as const;
export const workflowVerifierPackage = '@yourtechbudstudio/isagi-workflow-verifier' as const;
export const workflowSdkVersion = '0.0.1' as const;
export const workflowVerifierVersion = '0.0.1' as const;
export const workflowBuilderPackage = 'esbuild' as const;
export const workflowBuilderVersion = '0.28.0' as const;
export const workflowBuildCommand =
  'esbuild src/index.ts --bundle --format=esm --platform=node --target=node22 --log-override:unsupported-dynamic-import=error --outfile=dist/index.js' as const;
export const workflowVerifyCommand = 'isagi-workflow-verify --workflow .' as const;
export const verifierReservedPrefix = '.isagi-workflow-verifier-' as const;

export type PackageManagerName = 'pnpm' | 'npm' | 'bun';

export const workflowLockfileByPackageManager = {
  pnpm: 'pnpm-lock.yaml',
  npm: 'package-lock.json',
  bun: 'bun.lock',
} as const satisfies Record<PackageManagerName, string>;
export const supportedWorkflowLockfiles = Object.values(workflowLockfileByPackageManager);
export const unsupportedWorkflowLockfiles = ['bun.lockb'] as const;

export interface WorkflowBuildManifest {
  readonly manifestVersion: typeof workflowBuildManifestVersion;
  readonly workflowContractVersion: typeof supportedWorkflowContractVersion;
  readonly sdk: { readonly name: typeof workflowSdkPackage; readonly version: string };
  readonly verifier: { readonly name: typeof workflowVerifierPackage; readonly version: string };
  readonly toolchain: {
    readonly nodeVersion: string;
    readonly packageManager: { readonly name: PackageManagerName; readonly version: string };
  };
  readonly source: { readonly sha256: string };
  readonly artifact: { readonly entry: 'dist/index.js'; readonly sha256: string };
}

export interface HashInput {
  readonly path: string;
  readonly bytes: Uint8Array;
}

const sha256Pattern = /^[a-f0-9]{64}$/;

export function normalizeWorkflowPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`Path is outside the workflow package: ${path}`);
  }
  return normalized;
}

export function isWorkflowSourcePath(path: string): boolean {
  const normalized = normalizeWorkflowPath(path);
  if (normalized.startsWith(verifierReservedPrefix)) return false;
  return (
    normalized === 'package.json' ||
    normalized === 'tsconfig.json' ||
    supportedWorkflowLockfiles.includes(
      normalized as (typeof supportedWorkflowLockfiles)[number],
    ) ||
    normalized.startsWith('src/') ||
    normalized.startsWith('tests/')
  );
}

export function hashWorkflowInputs(inputs: readonly HashInput[]): string {
  const normalized = inputs
    .map((input) => ({ path: normalizeWorkflowPath(input.path), bytes: input.bytes }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const seen = new Set<string>();
  const hash = createHash('sha256');
  for (const input of normalized) {
    if (seen.has(input.path)) throw new Error(`Duplicate workflow hash input: ${input.path}`);
    seen.add(input.path);
    const pathBytes = Buffer.from(input.path, 'utf8');
    const size = Buffer.alloc(16);
    size.writeBigUInt64BE(BigInt(pathBytes.length), 0);
    size.writeBigUInt64BE(BigInt(input.bytes.byteLength), 8);
    hash.update(size).update(pathBytes).update(input.bytes);
  }
  return hash.digest('hex');
}

export function hashArtifact(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function serializeWorkflowBuildManifest(manifest: WorkflowBuildManifest): string {
  parseWorkflowBuildManifest(manifest);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function parseWorkflowBuildManifest(input: unknown): WorkflowBuildManifest {
  if (!isRecord(input)) throw new Error('Build manifest must be an object.');
  assertExactKeys(
    input,
    [
      'manifestVersion',
      'workflowContractVersion',
      'sdk',
      'verifier',
      'toolchain',
      'source',
      'artifact',
    ],
    'manifest',
  );
  if (input.manifestVersion !== workflowBuildManifestVersion)
    throw new Error(
      `Unsupported manifestVersion ${JSON.stringify(input.manifestVersion)}; this verifier supports ${workflowBuildManifestVersion}.`,
    );
  if (input.workflowContractVersion !== supportedWorkflowContractVersion)
    throw new Error(
      `Unsupported workflowContractVersion ${JSON.stringify(input.workflowContractVersion)}; this verifier supports ${supportedWorkflowContractVersion}.`,
    );
  const sdk = packageIdentity(input.sdk, 'sdk', workflowSdkPackage);
  const verifier = packageIdentity(input.verifier, 'verifier', workflowVerifierPackage);
  if (!isRecord(input.toolchain)) throw new Error('toolchain must be an object.');
  assertExactKeys(input.toolchain, ['nodeVersion', 'packageManager'], 'toolchain');
  if (typeof input.toolchain.nodeVersion !== 'string' || !input.toolchain.nodeVersion)
    throw new Error('toolchain.nodeVersion must be a non-empty string.');
  if (!isRecord(input.toolchain.packageManager))
    throw new Error('toolchain.packageManager must be an object.');
  assertExactKeys(input.toolchain.packageManager, ['name', 'version'], 'toolchain.packageManager');
  const name = input.toolchain.packageManager.name;
  if (name !== 'pnpm' && name !== 'npm' && name !== 'bun')
    throw new Error(
      `toolchain.packageManager.name must be pnpm, npm, or bun; found ${JSON.stringify(name)}.`,
    );
  const managerVersion = requiredString(
    input.toolchain.packageManager.version,
    'toolchain.packageManager.version',
  );
  const source = digestObject(input.source, 'source');
  if (!isRecord(input.artifact)) throw new Error('artifact must be an object.');
  assertExactKeys(input.artifact, ['entry', 'sha256'], 'artifact');
  if (input.artifact.entry !== 'dist/index.js')
    throw new Error('artifact.entry must be dist/index.js.');
  const artifactHash = requiredString(input.artifact.sha256, 'artifact.sha256');
  if (!sha256Pattern.test(artifactHash))
    throw new Error('artifact.sha256 must be a lowercase SHA-256 digest.');
  return {
    manifestVersion: workflowBuildManifestVersion,
    workflowContractVersion: supportedWorkflowContractVersion,
    sdk,
    verifier,
    toolchain: {
      nodeVersion: input.toolchain.nodeVersion,
      packageManager: { name, version: managerVersion },
    },
    source,
    artifact: { entry: 'dist/index.js', sha256: artifactHash },
  };
}

export function parseWorkflowBuildManifestJson(json: string): WorkflowBuildManifest {
  try {
    return parseWorkflowBuildManifest(JSON.parse(json));
  } catch (error) {
    throw new Error(
      `Invalid workflow build manifest: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function packageIdentity<Name extends string>(
  value: unknown,
  field: string,
  expectedName: Name,
): { name: Name; version: string } {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  assertExactKeys(value, ['name', 'version'], field);
  if (value.name !== expectedName) throw new Error(`${field}.name must be ${expectedName}.`);
  return { name: expectedName, version: requiredString(value.version, `${field}.version`) };
}
function digestObject(value: unknown, field: string) {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  assertExactKeys(value, ['sha256'], field);
  const sha256 = requiredString(value.sha256, `${field}.sha256`);
  if (!sha256Pattern.test(sha256))
    throw new Error(`${field}.sha256 must be a lowercase SHA-256 digest.`);
  return { sha256 };
}
function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${field} must be a non-empty string.`);
  return value;
}
function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  const unexpected = Object.keys(value).filter((key) => !expected.includes(key));
  if (missing.length === 0 && unexpected.length === 0) return;
  const parts = [
    ...(missing.length ? [`missing fields: ${missing.join(', ')}`] : []),
    ...(unexpected.length ? [`unexpected fields: ${unexpected.join(', ')}`] : []),
  ];
  throw new Error(`${field} has ${parts.join('; ')}.`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
