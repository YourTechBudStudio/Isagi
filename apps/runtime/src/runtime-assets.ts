import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeAssetRoot = findRuntimeAssetRoot();

const manifest = readJsonAsset('manifest.json') as {
  readonly runtimePackageVersion?: unknown;
  readonly workflowSdkPackageVersion?: unknown;
};

export const runtimePackageVersion =
  typeof manifest.runtimePackageVersion === 'string' ? manifest.runtimePackageVersion : '0.0.0';

export const workflowSdkPackageVersion =
  typeof manifest.workflowSdkPackageVersion === 'string'
    ? manifest.workflowSdkPackageVersion
    : '0.0.0';

export const configSchemaReferenceSources = {
  'runtime-config.schema.ts': readTextAsset('config-schemas/runtime-config.schema.ts'),
  'project-config.schema.ts': readTextAsset('config-schemas/project-config.schema.ts'),
} as const;

export const isagiDocsContentSources = {
  'SKILL.md': readTextAsset('isagi-docs/SKILL.md'),
  'config-global.md': readTextAsset('isagi-docs/config-global.md'),
  'config-project.md': readTextAsset('isagi-docs/config-project.md'),
  'workflows.md': readTextAsset('isagi-docs/workflows.md'),
} as const;

function findRuntimeAssetRoot() {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, 'assets'),
    resolve(moduleDirectory, '..', '.generated', 'assets'),
  ];
  const root = candidates.find((candidate) => existsSync(resolve(candidate, 'manifest.json')));
  if (!root) {
    throw new Error(`Could not find runtime assets. Checked: ${candidates.join(', ')}`);
  }
  return root;
}

function readTextAsset(relativePath: string) {
  return readFileSync(resolve(runtimeAssetRoot, relativePath), 'utf8');
}

function readJsonAsset(relativePath: string): unknown {
  return JSON.parse(readTextAsset(relativePath));
}
