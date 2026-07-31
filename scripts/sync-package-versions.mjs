#!/usr/bin/env node

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Cause, Data, Effect, Exit } from 'effect';

import { parseCanonicalVersion } from './release-version-contract.mjs';

const independentlyVersionedPackages = new Set([
  '@yourtechbudstudio/isagi-workflow-sdk',
  '@yourtechbudstudio/isagi-workflow-verifier',
]);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultFileSystem = { readFile, readdir, writeFile };

export class PackageVersionSyncError extends Data.TaggedError('PackageVersionSyncError') {}

export function createPackageVersionPlan({
  repoRoot,
  requestedVersion,
  fileSystem = defaultFileSystem,
}) {
  return Effect.gen(function* () {
    const normalizedRepoRoot = resolve(repoRoot);
    const workspaceManifestPaths = yield* discoverWorkspaceManifestPaths(
      normalizedRepoRoot,
      fileSystem,
    );
    const rootManifest = yield* readManifest(
      normalizedRepoRoot,
      join(normalizedRepoRoot, 'package.json'),
      fileSystem,
    );
    const workspaceManifests = yield* Effect.forEach(
      workspaceManifestPaths,
      (path) => readManifest(normalizedRepoRoot, path, fileSystem),
      { concurrency: 1 },
    );

    yield* validateInventory(workspaceManifests);

    const version = requestedVersion ?? rootManifest.packageJson.version;
    const parsedVersion = parseCanonicalVersion(version);
    if (parsedVersion._tag === 'invalid_version') {
      return yield* fail(`Invalid app version '${String(version)}'. ${parsedVersion.reason}`);
    }

    const synchronizedManifests = [
      rootManifest,
      ...workspaceManifests.filter(
        ({ packageJson }) => !independentlyVersionedPackages.has(packageJson.name),
      ),
    ].sort(compareManifestsWithRootFirst);
    const excludedManifests = workspaceManifests
      .filter(({ packageJson }) => independentlyVersionedPackages.has(packageJson.name))
      .sort(compareManifestPaths);
    const changes = synchronizedManifests
      .filter(({ packageJson }) => packageJson.version !== parsedVersion.version)
      .map(({ absolutePath, packageJson, relativePath }) =>
        Object.freeze({
          absolutePath,
          nextContent: formatPackageJson({
            ...packageJson,
            version: parsedVersion.version,
          }),
          relativePath,
        }),
      );

    return Object.freeze({
      changes: Object.freeze(changes),
      excludedManifestPaths: Object.freeze(
        excludedManifests.map(({ relativePath }) => relativePath),
      ),
      synchronizedManifestPaths: Object.freeze(
        synchronizedManifests.map(({ relativePath }) => relativePath),
      ),
      version: parsedVersion.version,
    });
  });
}

export function verifyPackageVersions(options) {
  return Effect.flatMap(createPackageVersionPlan(options), (plan) => {
    if (plan.changes.length === 0) {
      return Effect.succeed(plan);
    }
    return fail(
      `Package versions are not synchronized to ${plan.version}: ${plan.changes
        .map(({ relativePath }) => relativePath)
        .join(', ')}. Run 'pnpm versions:sync -- ${plan.version}'.`,
    );
  });
}

export function syncPackageVersions(options) {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  return Effect.flatMap(createPackageVersionPlan({ ...options, fileSystem }), (plan) =>
    Effect.as(
      Effect.forEach(
        plan.changes,
        ({ absolutePath, nextContent }) =>
          tryOperation(absolutePath, 'write', () =>
            fileSystem.writeFile(absolutePath, nextContent),
          ),
        { concurrency: 1, discard: true },
      ),
      plan,
    ),
  );
}

function discoverWorkspaceManifestPaths(repoRoot, fileSystem) {
  return Effect.gen(function* () {
    const workspacePath = join(repoRoot, 'pnpm-workspace.yaml');
    const workspaceFile = yield* tryOperation(workspacePath, 'read', () =>
      fileSystem.readFile(workspacePath, 'utf8'),
    );
    const packagePatterns = yield* parseWorkspacePackagePatterns(workspaceFile);
    const packageJsonPaths = new Set();

    for (const pattern of packagePatterns) {
      const workspaceDirectory = join(repoRoot, pattern.slice(0, -2));
      const entries = yield* tryOperation(workspaceDirectory, 'list', () =>
        fileSystem.readdir(workspaceDirectory, { withFileTypes: true }),
      );
      for (const entry of entries) {
        if (entry.isDirectory()) {
          packageJsonPaths.add(resolve(workspaceDirectory, entry.name, 'package.json'));
        }
      }
    }

    return [...packageJsonPaths].sort();
  });
}

function parseWorkspacePackagePatterns(workspaceFile) {
  const packagePatterns = [];
  let inPackagesList = false;

  for (const line of workspaceFile.split(/\r?\n/)) {
    if (line === 'packages:') {
      inPackagesList = true;
      continue;
    }
    if (!inPackagesList) {
      continue;
    }

    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }
    if (!/^\s/.test(line)) {
      break;
    }

    const listItemMatch = line.match(/^\s+-\s+(.+)$/);
    if (!listItemMatch) {
      return fail(
        `Unsupported line '${line.trim()}' inside the 'packages' list of pnpm-workspace.yaml. Version tooling supports a flat list of top-level directory wildcards such as 'apps/*'.`,
      );
    }
    const pattern = listItemMatch[1].trim().replace(/^['"]|['"]$/g, '');
    if (isAbsolute(pattern) || pattern.includes('..') || !/^[A-Za-z0-9._-]+\/\*$/.test(pattern)) {
      return fail(
        `Unsupported pnpm workspace package pattern '${pattern}'. Version tooling supports top-level directory wildcards such as 'apps/*'.`,
      );
    }
    packagePatterns.push(pattern);
  }

  if (packagePatterns.length === 0) {
    return fail('No packages were found in pnpm-workspace.yaml.');
  }
  return Effect.succeed(packagePatterns);
}

function readManifest(repoRoot, absolutePath, fileSystem) {
  return Effect.gen(function* () {
    const content = yield* tryOperation(absolutePath, 'read', () =>
      fileSystem.readFile(absolutePath, 'utf8'),
    );
    const packageJson = yield* Effect.try({
      try: () => JSON.parse(content),
      catch: (cause) =>
        new PackageVersionSyncError({
          message: `Could not parse ${toRepositoryPath(repoRoot, absolutePath)} as JSON.`,
          cause,
        }),
    });
    const relativePath = toRepositoryPath(repoRoot, absolutePath);

    if (!isRecord(packageJson)) {
      return yield* fail(`Expected ${relativePath} to contain a JSON object.`);
    }
    if (typeof packageJson.name !== 'string' || packageJson.name.trim() === '') {
      return yield* fail(`Expected ${relativePath} to have a nonempty string 'name'.`);
    }
    if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') {
      return yield* fail(`Expected ${relativePath} to have a nonempty string 'version'.`);
    }

    return Object.freeze({ absolutePath, content, packageJson, relativePath });
  });
}

function validateInventory(workspaceManifests) {
  return Effect.gen(function* () {
    const manifestsByName = new Map();
    for (const manifest of workspaceManifests) {
      const duplicate = manifestsByName.get(manifest.packageJson.name);
      if (duplicate) {
        return yield* fail(
          `Duplicate workspace package name '${manifest.packageJson.name}' in ${duplicate.relativePath} and ${manifest.relativePath}.`,
        );
      }
      manifestsByName.set(manifest.packageJson.name, manifest);
    }

    for (const packageName of independentlyVersionedPackages) {
      if (!manifestsByName.has(packageName)) {
        return yield* fail(
          `Missing independently versioned workspace package '${packageName}'. It must appear exactly once.`,
        );
      }
    }

    for (const manifest of workspaceManifests) {
      if (
        !independentlyVersionedPackages.has(manifest.packageJson.name) &&
        manifest.packageJson.private !== true
      ) {
        return yield* fail(
          `Unexpected public workspace package '${manifest.packageJson.name}' in ${manifest.relativePath}. Only the workflow SDK and workflow verifier may be public.`,
        );
      }
    }
  });
}

function compareManifestsWithRootFirst(left, right) {
  if (left.relativePath === 'package.json') return -1;
  if (right.relativePath === 'package.json') return 1;
  return compareManifestPaths(left, right);
}

function compareManifestPaths(left, right) {
  if (left.relativePath < right.relativePath) return -1;
  if (left.relativePath > right.relativePath) return 1;
  return 0;
}

function toRepositoryPath(repoRoot, path) {
  return relative(repoRoot, path).split(sep).join('/');
}

function formatPackageJson(packageJson) {
  return `${JSON.stringify(packageJson, null, 2)}\n`;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryOperation(path, operation, run) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new PackageVersionSyncError({
        message: `Could not ${operation} ${path}.`,
        cause,
      }),
  });
}

function fail(message) {
  return Effect.fail(new PackageVersionSyncError({ message }));
}

function parseSyncArguments(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return Effect.succeed({ help: true });
  }
  const commandArgs = args[0] === '--' ? args.slice(1) : args;
  if (commandArgs.length > 1) {
    return fail('Expected at most one version argument.');
  }
  return Effect.succeed({ help: false, requestedVersion: commandArgs[0] });
}

export function syncHelpText() {
  return [
    'Usage: pnpm versions:sync [-- MAJOR.MINOR.PATCH]',
    '',
    'Synchronize the root and all private workspace package versions.',
    'Review and commit the resulting manifest changes, then push them to origin/main.',
    '',
    'This does not tag or release anything. Create and review a draft GitHub release, then',
    'publish it to start the builds and attach their artifacts. See the release process section of',
    'docs/development-runtime.md for the full sequence.',
  ].join('\n');
}

async function runCli() {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const parsedArguments = yield* parseSyncArguments(process.argv.slice(2));
      if (parsedArguments.help) {
        return parsedArguments;
      }
      const plan = yield* syncPackageVersions({
        repoRoot: repositoryRoot,
        requestedVersion: parsedArguments.requestedVersion,
      });
      return { help: false, plan };
    }),
  );
  if (Exit.isFailure(exit)) {
    console.error(Cause.pretty(exit.cause, { renderErrorCause: true }));
    process.exitCode = 1;
    return;
  }
  if (exit.value.help) {
    console.log(syncHelpText());
    return;
  }

  const plan = exit.value.plan;
  console.log(
    `Synchronized ${plan.synchronizedManifestPaths.length} manifests to ${plan.version}; wrote ${plan.changes.length} changed manifests and left ${plan.excludedManifestPaths.length} independently versioned manifests unchanged.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
