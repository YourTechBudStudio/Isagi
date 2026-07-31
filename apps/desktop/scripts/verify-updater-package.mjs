import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { extractFile, listPackage } from '@electron/asar';

const archivedBundlePath = 'dist-electron/main/index.js';

export async function verifyUpdaterPackage({ asarPath, sourceRoot }) {
  const archiveEntries = new Set(listPackage(asarPath).map(normalizeArchivePath));
  if (!archiveEntries.has(archivedBundlePath))
    throw new Error(`Packaged main bundle is missing: ${archivedBundlePath}`);

  // Analyze the bundle that actually ships, not the workspace build output beside it.
  const bundle = extractFile(asarPath, archivedBundlePath).toString('utf8');
  const loadMatches =
    bundle.match(/[A-Za-z_$][\w$]*\(import\.meta\.url\)\([`"']electron-updater[`"']\)/gu) ?? [];
  if (loadMatches.length !== 1) {
    throw new Error(
      `Expected one packaged electron-updater load site, found ${loadMatches.length}.`,
    );
  }
  if (/class\s+AppUpdater\b/u.test(bundle) || /class\s+AppImageUpdater\b/u.test(bundle)) {
    throw new Error('The main bundle contains inlined electron-updater implementation source.');
  }

  const sourceImports = await updaterSourceImports(sourceRoot);
  const runtimeImports = sourceImports.filter(({ line }) => !/^\s*import\s+type\b/u.test(line));
  if (runtimeImports.length > 0) {
    throw new Error(
      `Non-type electron-updater imports are not allowed: ${runtimeImports.map(({ path }) => path).join(', ')}.`,
    );
  }

  const closure = productionDependencyClosure(asarPath, archiveEntries, 'electron-updater');
  return {
    archiveEntryCount: archiveEntries.size,
    dependencyCount: closure.size,
    loadSiteCount: 1,
  };
}

function productionDependencyClosure(asarPath, archiveEntries, rootName) {
  const pending = [rootName];
  const visited = new Set();
  while (pending.length > 0) {
    const name = pending.shift();
    if (!name || visited.has(name)) continue;
    const manifestPath = `node_modules/${name}/package.json`;
    if (!archiveEntries.has(manifestPath))
      throw new Error(`Packaged updater dependency is missing: ${manifestPath}`);
    visited.add(name);
    const manifest = JSON.parse(extractFile(asarPath, manifestPath).toString('utf8'));
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    }).sort()) {
      if (!visited.has(dependency)) pending.push(dependency);
    }
  }
  return visited;
}

async function updaterSourceImports(sourceRoot) {
  const results = [];
  for (const path of await sourceFiles(sourceRoot)) {
    const contents = await readFile(path, 'utf8');
    for (const line of contents.split('\n')) {
      if (/(?:from\s+|import\s*\()["']electron-updater["']/u.test(line)) {
        results.push({ path: relative(sourceRoot, path), line });
      }
    }
  }
  return results;
}

async function sourceFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith('.ts')) paths.push(path);
  }
  return paths;
}

function normalizeArchivePath(path) {
  return path.replace(/^[/\\]+/u, '').replaceAll('\\', '/');
}
