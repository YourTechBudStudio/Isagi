import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeAssetRoot = findRuntimeAssetRoot();

const manifest = readJsonAsset('manifest.json') as {
  readonly runtimePackageVersion?: unknown;
};

export const runtimePackageVersion =
  typeof manifest.runtimePackageVersion === 'string' ? manifest.runtimePackageVersion : '0.0.0';

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

/**
 * The canonical workflow scaffold, copied verbatim from the verifier fixture at build time and
 * keyed by POSIX-relative path (e.g. `src/index.ts`). The shipped skill emits these as reference
 * files, and an anti-drift test asserts the emitted bytes equal these source bytes.
 */
export const workflowScaffoldSources: ReadonlyMap<string, string> = readWorkflowScaffoldSources();

function readWorkflowScaffoldSources(): ReadonlyMap<string, string> {
  const scaffoldRoot = resolve(runtimeAssetRoot, 'minimal-workflow');
  const files = new Map<string, string>();
  for (const absolute of walkFiles(scaffoldRoot)) {
    const key = relative(scaffoldRoot, absolute).split(sep).join('/');
    files.set(key, readFileSync(absolute, 'utf8'));
  }
  if (files.size === 0) {
    throw new Error(`No workflow scaffold assets found under ${scaffoldRoot}.`);
  }
  return files;
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(absolute));
    else if (entry.isFile()) out.push(absolute);
  }
  return out.sort();
}

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
