#!/usr/bin/env node

// Completes the CLI build: copies the runtime's build output (`index.js`, `assets/`, `drizzle/`) into `dist/` beside the
// `isagi.mjs` bundle Vite just wrote, and the web build into `web/`. The result, `dist/` plus `web/`, is what the npm
// package ships and what the desktop app stages (`dist/` only). With `--check` (the package's `prepack`), it only
// confirms that `dist/` and `web/` are a complete distribution without build caches, because the CLI's own `bundle`
// (run by `dev`, `test` and `check`) leaves `dist/` holding `isagi.mjs` alone.

import { chmodSync, cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { serveDistributionFiles } from '../distribution.mjs';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [entryFile, ...runtimeFiles] = serveDistributionFiles;

/**
 * Assembles `<cliRoot>/dist` and `<cliRoot>/web` from the runtime and web build outputs. Fails, naming every missing
 * input, before it copies anything.
 */
export function assembleDistribution({
  root = cliRoot,
  runtimeDist = resolve(root, '../runtime/dist'),
  webDist = resolve(root, '../web/dist'),
} = {}) {
  const distRoot = resolve(root, 'dist');
  const webRoot = resolve(root, 'web');
  const missing = [
    resolve(distRoot, entryFile),
    ...runtimeFiles.map((file) => resolve(runtimeDist, file)),
    resolve(webDist, 'index.html'),
  ].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(`Missing build output ${missing.join(', ')}; run pnpm build first.`);
  }

  // TypeScript's build cache lands in build outputs when a typecheck follows a build; it lists local paths, so it
  // never ships.
  const withoutBuildCache = {
    recursive: true,
    filter: (/** @type {string} */ source) => !source.endsWith('.tsbuildinfo'),
  };
  cpSync(runtimeDist, distRoot, withoutBuildCache);
  rmSync(webRoot, { recursive: true, force: true });
  cpSync(webDist, webRoot, withoutBuildCache);
  // `isagi.mjs` is the package's `bin` and the desktop stage's entry; keep it executable.
  chmodSync(resolve(distRoot, entryFile), 0o755);
  return { distRoot, webRoot };
}

/**
 * Fails, naming what is wrong, unless `<root>/dist` and `<root>/web` are a complete assembled distribution with no
 * TypeScript build cache in either.
 */
export function checkDistribution({ root = cliRoot } = {}) {
  const missing = [
    ...serveDistributionFiles.map((file) => resolve(root, 'dist', file)),
    resolve(root, 'web/index.html'),
  ].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `Incomplete distribution: missing ${missing.join(', ')}; run pnpm -w build (or pnpm -w package:npm) before packing.`,
    );
  }
  const caches = ['dist', 'web']
    .filter((directory) => existsSync(resolve(root, directory)))
    .flatMap((directory) =>
      readdirSync(resolve(root, directory), { recursive: true, encoding: 'utf8' })
        .filter((entry) => entry.endsWith('.tsbuildinfo'))
        .map((entry) => relative(root, resolve(root, directory, entry))),
    );
  if (caches.length > 0) {
    throw new Error(
      `The distribution holds build caches ${caches.join(', ')}; run pnpm -w build before packing.`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    checkDistribution();
  } else {
    const { distRoot, webRoot } = assembleDistribution();
    console.log(`assembled ${distRoot} and ${webRoot}`);
  }
}
