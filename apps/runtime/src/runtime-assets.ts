import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
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

export const workflowSdkDistSources = readTextAssetTree('workflow-sdk/dist');

export const workflowSdkReferenceSources = readTextAssetTree('workflow-sdk/src');

export const configSchemaReferenceSources = {
  'runtime-config.schema.ts': readTextAsset('config-schemas/runtime-config.schema.ts'),
  'project-config.schema.ts': readTextAsset('config-schemas/project-config.schema.ts'),
} as const;

export const configureIsagiSkillContentSources = {
  'SKILL.md': readTextAsset('configure-isagi/SKILL.md'),
  'config-global.md': readTextAsset('configure-isagi/config-global.md'),
  'config-project.md': readTextAsset('configure-isagi/config-project.md'),
  'workflows.md': readTextAsset('configure-isagi/workflows.md'),
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

function readTextAssetTree(relativeRoot: string): Readonly<Record<string, string>> {
  const root = resolve(runtimeAssetRoot, relativeRoot);
  return Object.fromEntries(
    listFiles(root).map((path) => [
      normalizeAssetPath(relative(root, path)),
      readFileSync(path, 'utf8'),
    ]),
  );
}

function listFiles(root: string): readonly string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    if (!entry.isFile()) return [];
    statSync(path);
    return [path];
  });
}

function normalizeAssetPath(path: string) {
  return path.split(/[\\/]+/).join('/');
}
