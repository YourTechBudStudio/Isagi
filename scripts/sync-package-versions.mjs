#!/usr/bin/env node

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Cause, Data, Effect, Exit } from 'effect';

const independentlyVersionedPackages = new Set([
  '@yourtechbudstudio/isagi-workflow-sdk',
  '@yourtechbudstudio/isagi-workflow-verifier',
]);
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export class PackageVersionSyncError extends Data.TaggedError('PackageVersionSyncError') {}

export function syncPackageVersions({ repoRoot, requestedVersion }) {
  return Effect.gen(function* () {
    const rootPackageJsonPath = join(repoRoot, 'package.json');
    const rootPackageJson = yield* readPackageJson(rootPackageJsonPath);
    const version = requestedVersion ?? rootPackageJson.version;

    if (!version) {
      return yield* fail(
        'Root package.json has no version. Pass one, for example: pnpm versions:sync -- 0.1.0',
      );
    }
    if (!semverPattern.test(version)) {
      return yield* fail(`Expected a semver version, received '${version}'.`);
    }

    if (rootPackageJson.version !== version) {
      yield* writePackageJson(rootPackageJsonPath, { ...rootPackageJson, version });
    }

    const workspacePackageJsonPaths = yield* getWorkspacePackageJsonPaths(repoRoot);
    let synchronizedPackageCount = 0;
    let excludedPackageCount = 0;

    for (const packageJsonPath of workspacePackageJsonPaths) {
      const packageJson = yield* readPackageJson(packageJsonPath);

      if (independentlyVersionedPackages.has(packageJson.name)) {
        excludedPackageCount += 1;
        continue;
      }

      synchronizedPackageCount += 1;
      if (packageJson.version !== version) {
        yield* writePackageJson(packageJsonPath, { ...packageJson, version });
      }
    }

    return { excludedPackageCount, synchronizedPackageCount, version };
  });
}

function getWorkspacePackageJsonPaths(repoRoot) {
  return Effect.gen(function* () {
    const workspacePath = join(repoRoot, 'pnpm-workspace.yaml');
    const workspaceFile = yield* tryOperation(workspacePath, 'read', () =>
      readFile(workspacePath, 'utf8'),
    );
    const packagePatterns = workspacePackagePatterns(workspaceFile);
    if (packagePatterns.length === 0) {
      return yield* fail('No packages were found in pnpm-workspace.yaml.');
    }
    const packageJsonPaths = [];

    for (const pattern of packagePatterns) {
      if (!pattern.endsWith('/*')) {
        packageJsonPaths.push(join(repoRoot, pattern, 'package.json'));
        continue;
      }

      const workspaceDirectory = join(repoRoot, pattern.slice(0, -2));
      const entries = yield* tryOperation(workspaceDirectory, 'list', () =>
        readdir(workspaceDirectory, { withFileTypes: true }),
      );
      for (const entry of entries) {
        if (entry.isDirectory()) {
          packageJsonPaths.push(join(workspaceDirectory, entry.name, 'package.json'));
        }
      }
    }

    return packageJsonPaths;
  });
}

function workspacePackagePatterns(workspaceFile) {
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

    const listItemMatch = line.match(/^\s+-\s+(.+)$/);
    if (!listItemMatch) {
      break;
    }
    packagePatterns.push(listItemMatch[1].replace(/^['"]|['"]$/g, ''));
  }

  return packagePatterns;
}

function readPackageJson(path) {
  return tryOperation(path, 'read', async () => JSON.parse(await readFile(path, 'utf8')));
}

function writePackageJson(path, packageJson) {
  return tryOperation(path, 'write', () =>
    writeFile(path, `${JSON.stringify(packageJson, null, 2)}\n`),
  );
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

function parseRequestedVersion(args) {
  const commandArgs = args[0] === '--' ? args.slice(1) : args;
  if (commandArgs.length > 1) {
    return fail('Expected at most one version argument.');
  }
  return Effect.succeed(commandArgs[0]);
}

async function runCli() {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const requestedVersion = yield* parseRequestedVersion(process.argv.slice(2));
      return yield* syncPackageVersions({ repoRoot: repositoryRoot, requestedVersion });
    }),
  );
  if (Exit.isFailure(exit)) {
    console.error(Cause.pretty(exit.cause, { renderErrorCause: true }));
    process.exitCode = 1;
    return;
  }

  const result = exit.value;
  console.log(
    `Synced ${result.synchronizedPackageCount} workspace package versions to ${result.version}; left ${result.excludedPackageCount} independently versioned workflow packages unchanged.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
