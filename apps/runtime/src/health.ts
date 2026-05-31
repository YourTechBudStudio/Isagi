import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';

let cachedVersion: string | undefined;

export function getRuntimeHealth() {
  return Effect.gen(function* () {
    const version = yield* getRuntimeVersion();

    return {
      context: {
        arch: process.arch,
        node: process.version,
        pid: process.pid,
        platform: process.platform,
      },
      name: 'isagi-runtime' as const,
      ok: true as const,
      timestamp: new Date().toISOString(),
      version,
    };
  });
}

function getRuntimeVersion() {
  if (cachedVersion !== undefined) {
    return Effect.succeed(cachedVersion);
  }

  return readRuntimeVersion().pipe(
    Effect.tap((version) =>
      Effect.sync(() => {
        cachedVersion = version;
      }),
    ),
  );
}

function readRuntimeVersion() {
  return Effect.firstSuccessOf(getPackageJsonPaths().map(readPackageVersion)).pipe(
    Effect.catchAll(() => Effect.succeed('0.0.0')),
  );
}

function readPackageVersion(packageJsonPath: string) {
  return Effect.gen(function* () {
    const packageJson = yield* Effect.try({
      try: () =>
        JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
          version?: unknown;
        },
      catch: toError,
    });

    if (typeof packageJson.version !== 'string') {
      return yield* Effect.fail(new Error(`${packageJsonPath} did not include a version`));
    }

    return packageJson.version;
  });
}

function getPackageJsonPaths() {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));

  return [join(currentDirectory, '../package.json'), join(currentDirectory, 'package.json')];
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
