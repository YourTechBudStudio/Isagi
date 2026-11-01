#!/usr/bin/env node

// Generates the public `@yourtechbudstudio/isagi` package from the serve distribution (`apps/runtime/dist`) and the
// web build (`apps/web/dist`), then packs it. The package is generated rather than a workspace package so that no
// `workspace:*` dependency or source tree can leak into it; `verify.mjs` exercises the packed tarball.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { serveDistributionFiles } from '../../apps/runtime/runtime-externals.mjs';

export const packageName = '@yourtechbudstudio/isagi';
export const distributionFiles = serveDistributionFiles;

const repositoryUrl = 'https://github.com/YourTechBudStudio/Isagi';
const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The generated manifest. Its version follows the root `package.json` (kept in step by `pnpm versions:sync`) and its
 * dependencies are the runtime's externals as `packages/runtime-stage-dependencies` declares them.
 */
export function npmPackageManifest({ rootManifest, stageDependencies }) {
  return {
    name: packageName,
    version: rootManifest.version,
    description:
      'Isagi: resumable worktree-based development environments. `isagi serve` runs the runtime.',
    license: 'Apache-2.0',
    type: 'module',
    bin: { isagi: 'dist/isagi.mjs' },
    files: ['dist', 'web'],
    dependencies: { ...stageDependencies.dependencies },
    engines: { node: rootManifest.engines.node },
    repository: { type: 'git', url: `git+${repositoryUrl}.git` },
    publishConfig: { access: 'public' },
  };
}

/**
 * Assembles `<outputRoot>/package/` and packs it into `<outputRoot>`. `outputRoot` is relative to `repoRoot`; both
 * returned paths are absolute.
 */
export async function assembleNpmPackage({
  repoRoot = defaultRepoRoot,
  outputRoot = '.generated/npm-package',
} = {}) {
  const runtimeDist = resolve(repoRoot, 'apps/runtime/dist');
  const webDist = resolve(repoRoot, 'apps/web/dist');
  for (const required of [
    ...distributionFiles.map((file) => resolve(runtimeDist, file)),
    resolve(webDist, 'index.html'),
  ]) {
    if (!existsSync(required)) {
      throw new Error(`Missing build output ${required}; run pnpm build first.`);
    }
  }

  const manifest = npmPackageManifest({
    rootManifest: readJson(resolve(repoRoot, 'package.json')),
    stageDependencies: readJson(
      resolve(repoRoot, 'packages/runtime-stage-dependencies/package.json'),
    ),
  });
  const outputDirectory = resolve(repoRoot, outputRoot);
  const packageRoot = resolve(outputDirectory, 'package');
  rmSync(packageRoot, { recursive: true, force: true });
  mkdirSync(packageRoot, { recursive: true });

  // TypeScript's build cache lands in both build outputs when a typecheck follows a build; it lists local paths, so it
  // never ships.
  const withoutBuildCache = {
    recursive: true,
    filter: (source) => !source.endsWith('.tsbuildinfo'),
  };
  cpSync(runtimeDist, resolve(packageRoot, 'dist'), withoutBuildCache);
  cpSync(webDist, resolve(packageRoot, 'web'), withoutBuildCache);
  cpSync(resolve(repoRoot, 'LICENSE'), resolve(packageRoot, 'LICENSE'));
  writeFileSync(resolve(packageRoot, 'README.md'), readme(manifest));
  writeFileSync(resolve(packageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const tarballPath = resolve(
    outputDirectory,
    `${manifest.name.replace(/^@/u, '').replace('/', '-')}-${manifest.version}.tgz`,
  );
  rmSync(tarballPath, { force: true });
  // npm resolves a relative destination against its working directory, so the destination is always absolute.
  const pack = spawnSync('npm', ['pack', '--pack-destination', outputDirectory], {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (pack.error) throw pack.error;
  if (pack.status !== 0) throw new Error(`npm pack exited with status ${pack.status}`);
  if (!existsSync(tarballPath)) {
    throw new Error(`npm pack did not write ${tarballPath}; it printed: ${pack.stdout.trim()}`);
  }
  return { packageRoot, tarballPath };
}

function readme(manifest) {
  return `# ${manifest.name}

Isagi gives you resumable, worktree-based development environments. This package is the \`isagi\` command: \`isagi serve\` runs an Isagi runtime, and \`isagi workflows\` talks to one.

## Install

Requires Node.js ${manifest.engines.node}.

\`\`\`sh
npm install --global ${manifest.name}
\`\`\`

## Run a runtime

\`\`\`sh
isagi serve
isagi serve --port 11299
isagi serve --host 0.0.0.0 --data-dir ~/isagi-server
\`\`\`

\`isagi serve\` runs until it is stopped (Ctrl-C or SIGTERM) and prints \`ISAGI_RUNTIME_READY\` with its URL once it listens.

| Flag | Environment variable | Default |
| --- | --- | --- |
| \`--host <address>\` | \`ISAGI_HOST\` | \`server.host\` in \`config.yaml\`, else \`127.0.0.1\` |
| \`--port <0-65535>\` | \`ISAGI_PORT\` | \`server.port\` in \`config.yaml\`, else \`0\` (a free port) |
| \`--data-dir <path>\` | \`ISAGI_DATA_DIR\` | \`~/.isagi\` |
| \`--allowed-origins <origin,…>\` | — | none |
| \`--web-root <path>\` | — | the copy bundled with \`isagi\`; served only when \`server.serveWebUi\` is true |

A flag beats its environment variable, which beats \`config.yaml\` in the data directory, which beats the default. Run \`isagi --help\` or \`isagi serve --help\` for every command and flag; add \`--json\` for machine-readable errors.

## More

${repositoryUrl}
`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { tarballPath } = await assembleNpmPackage();
  console.log(tarballPath);
}
