import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The one build-asset root. The build copies repository-owned files into it
// (`scripts/sync-runtime-assets.mjs`); each owning module declares its own asset
// constants with the helpers below, so this area names no domain asset.
//
// Assets ship inside the runtime, so a missing or unreadable one is a build
// defect rather than an operational condition: owners read them at module load
// and let a failure throw during import.

const runtimeAssetRoot = findRuntimeAssetRoot();

const manifest = readJsonAsset('manifest.json') as {
  readonly runtimePackageVersion?: unknown;
};

/** The runtime package's version, recorded in the asset manifest at build time. */
export const runtimePackageVersion =
  typeof manifest.runtimePackageVersion === 'string' ? manifest.runtimePackageVersion : '0.0.0';

/** The absolute path of an asset file, asserting that it exists. */
export function requireAssetFile(relativePath: string) {
  const path = resolve(runtimeAssetRoot, relativePath);
  if (!existsSync(path)) {
    throw new Error(`Missing runtime asset ${relativePath} under ${runtimeAssetRoot}.`);
  }
  return path;
}

/** An asset file's text. */
export function readTextAsset(relativePath: string) {
  return readFileSync(resolve(runtimeAssetRoot, relativePath), 'utf8');
}

/**
 * Every file under an asset directory, as text keyed by its POSIX-relative path
 * (e.g. `src/index.ts`), in sorted path order. `directory` is the absolute path
 * that was read, for the owner's own error messages.
 */
export function readTextAssetTree(relativeDirectory: string): {
  readonly directory: string;
  readonly files: ReadonlyMap<string, string>;
} {
  const directory = resolve(runtimeAssetRoot, relativeDirectory);
  const files = new Map<string, string>();
  for (const absolute of walkFiles(directory)) {
    const key = relative(directory, absolute).split(sep).join('/');
    files.set(key, readFileSync(absolute, 'utf8'));
  }
  return { directory, files };
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
    resolve(moduleDirectory, '..', '..', '..', '.generated', 'assets'),
  ];
  const root = candidates.find((candidate) => existsSync(resolve(candidate, 'manifest.json')));
  if (!root) {
    throw new Error(`Could not find runtime assets. Checked: ${candidates.join(', ')}`);
  }
  return root;
}

function readJsonAsset(relativePath: string): unknown {
  return JSON.parse(readTextAsset(relativePath));
}
