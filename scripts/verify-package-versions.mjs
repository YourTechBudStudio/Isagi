#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Cause, Effect, Exit } from 'effect';

import { PackageVersionSyncError, verifyPackageVersions } from './sync-package-versions.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function verificationOutput(plan) {
  return {
    version: plan.version,
    synchronizedManifestPaths: plan.synchronizedManifestPaths,
    excludedManifestPaths: plan.excludedManifestPaths,
  };
}

export function verifyHelpText() {
  return [
    'Usage: pnpm versions:verify',
    '',
    'Verify that the root and all private workspace package versions are synchronized.',
    'Print one JSON object on success and never modify repository files.',
  ].join('\n');
}

function parseVerifyArguments(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return Effect.succeed({ help: true });
  }
  if (args.length > 0) {
    return Effect.fail(
      new PackageVersionSyncError({
        message: 'versions:verify does not accept positional arguments.',
      }),
    );
  }
  return Effect.succeed({ help: false });
}

async function runCli() {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const parsedArguments = yield* parseVerifyArguments(process.argv.slice(2));
      if (parsedArguments.help) {
        return parsedArguments;
      }
      const plan = yield* verifyPackageVersions({ repoRoot: repositoryRoot });
      return { help: false, plan };
    }),
  );
  if (Exit.isFailure(exit)) {
    console.error(Cause.pretty(exit.cause, { renderErrorCause: true }));
    process.exitCode = 1;
    return;
  }
  if (exit.value.help) {
    console.log(verifyHelpText());
    return;
  }

  console.log(JSON.stringify(verificationOutput(exit.value.plan)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
