// Dependency rules for the Effect v4 end state (verification §3.4). One message per violation, each starting with its
// rule id so the runner can keep a rule report-only (`reportRules`).
//   D1  banned packages never appear in a workspace manifest: React Query and Zustand (Effect-native state, ADR 0001),
//       and the v3-era `@effect/schema`, `@effect/platform`, `@effect/rx*`, `@effect/experimental` (folded into
//       `effect` in v4)
//   D2  `effect` and every `@effect/*` dependency is declared as `catalog:`, so one version line lives in
//       `pnpm-workspace.yaml`
//   D3  `pnpm-lock.yaml` resolves exactly one version of `effect` (two instances break Context/Schema identity)
//
// Manifests are the root `package.json` plus every package matched by the `packages:` globs of `pnpm-workspace.yaml`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from './source-files.mjs';

const BANNED_EXACT = new Set([
  'zustand',
  '@effect/schema',
  '@effect/platform',
  '@effect/experimental',
]);
const BANNED_PREFIXES = ['@tanstack/react-query', '@effect/rx'];
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** @param {string} name */
export const isBanned = (name) =>
  BANNED_EXACT.has(name) || BANNED_PREFIXES.some((prefix) => name.startsWith(prefix));

/** @param {string} name */
const isEffectPackage = (name) => name === 'effect' || name.startsWith('@effect/');

/**
 * Package directories (repo-relative) from the `packages:` list of `pnpm-workspace.yaml`. Supports the forms the repo
 * uses, `<dir>/*` and `<dir>`; anything else is a configuration error so a new workspace shape is never skipped.
 * @param {string} repoRoot
 * @returns {string[]}
 */
export const workspacePackageDirs = (repoRoot) => {
  const workspacePath = join(repoRoot, 'pnpm-workspace.yaml');
  if (!existsSync(workspacePath))
    throw new Error(`dependency-policy: ${workspacePath} does not exist`);
  const lines = readFileSync(workspacePath, 'utf8').split('\n');
  const start = lines.findIndex((line) => /^packages:\s*$/.test(line));
  if (start === -1) throw new Error('dependency-policy: pnpm-workspace.yaml has no packages: list');
  /** @type {string[]} */
  const dirs = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const item = /^\s+-\s+['"]?([^'"#\s]+)['"]?\s*$/.exec(line);
    if (item === null) break;
    const glob = item[1];
    if (/^[\w.-]+(\/[\w.-]+)*\/\*$/.test(glob)) {
      const parent = glob.slice(0, -2);
      if (!existsSync(join(repoRoot, parent))) continue;
      for (const entry of readdirSync(join(repoRoot, parent), { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(`${parent}/${entry.name}`);
      }
    } else if (/^[\w.-]+(\/[\w.-]+)*$/.test(glob)) dirs.push(glob);
    else
      throw new Error(`dependency-policy: unsupported pnpm-workspace.yaml package pattern ${glob}`);
  }
  return dirs.sort();
};

/**
 * Versions of `effect` the lockfile resolves (keys of its `packages:`/`snapshots:` maps; peer suffixes ignored).
 * @param {string} lockfile text of pnpm-lock.yaml
 */
export const lockedEffectVersions = (lockfile) =>
  [
    ...new Set([...lockfile.matchAll(/^ {2}'?effect@([^:'(\s]+)/gm)].map((match) => match[1])),
  ].sort();

/**
 * @param {string} repoRoot absolute repo root
 * @returns {string[]} one message per violation; empty when the repo conforms
 */
export const checkDependencyPolicy = (repoRoot) => {
  /** @type {string[]} */
  const errors = [];
  const manifests = [
    'package.json',
    ...workspacePackageDirs(repoRoot)
      .map((dir) => `${dir}/package.json`)
      .filter((manifest) => existsSync(join(repoRoot, manifest))),
  ];
  for (const manifest of manifests) {
    const pkg = JSON.parse(readFileSync(join(repoRoot, manifest), 'utf8'));
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        if (isBanned(name))
          errors.push(
            `D1 ${manifest}: ${field}.${name} is banned (Effect-native state replaces it, or v4 folded it into effect)`,
          );
        if (isEffectPackage(name) && spec !== 'catalog:')
          errors.push(
            `D2 ${manifest}: ${field}.${name} is ${JSON.stringify(spec)}; declare it as "catalog:" (version lives in pnpm-workspace.yaml)`,
          );
      }
    }
  }
  const lockPath = join(repoRoot, 'pnpm-lock.yaml');
  if (!existsSync(lockPath)) throw new Error(`dependency-policy: ${lockPath} does not exist`);
  const versions = lockedEffectVersions(readFileSync(lockPath, 'utf8'));
  if (versions.length !== 1)
    errors.push(
      `D3 pnpm-lock.yaml resolves effect at ${versions.join(', ') || 'no version'}; expected exactly one`,
    );
  return errors;
};

if (isMainModule(import.meta.url)) {
  const repoRoot = resolve(
    process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '../..'),
  );
  const errors = checkDependencyPolicy(repoRoot);
  for (const error of errors) console.error(error);
  console.error(`dependency-policy: ${errors.length} violation(s)`);
  process.exit(errors.length > 0 ? 1 : 0);
}
