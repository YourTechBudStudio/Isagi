import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Cause, Data, Effect, Exit } from 'effect';

import { smokeRuntimeStage } from './runtime-stage/smoke.mjs';
import { prepareRuntimeStage } from './runtime-stage/stage.mjs';

class CommandStartError extends Data.TaggedError('CommandStartError') {}
class PackagedRuntimeMissingError extends Data.TaggedError('PackagedRuntimeMissingError') {}

const executableSuffix = process.platform === 'win32' ? '.cmd' : '';
const desktopDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const electronBuilderCommand = join(
  desktopDirectory,
  'node_modules',
  '.bin',
  `electron-builder${executableSuffix}`,
);

const program = Effect.gen(function* () {
  yield* prepareRuntimeStage();
  const packageResult = yield* runCommand(electronBuilderCommand, process.argv.slice(2));
  const packageExitCode = commandExitCode(packageResult);
  if (packageExitCode !== 0) return packageExitCode;

  const packagedRuntimeRoot = yield* Effect.try({
    try: findPackagedRuntimeRoot,
    catch: (cause) => new PackagedRuntimeMissingError({ cause }),
  });
  yield* smokeRuntimeStage(packagedRuntimeRoot);
  return 0;
});

const exit = await Effect.runPromiseExit(program);

if (Exit.isFailure(exit)) {
  console.error(Cause.pretty(exit.cause, { renderErrorCause: true }));
  process.exitCode = 1;
} else {
  process.exitCode = exit.value;
}

function runCommand(command, args) {
  return Effect.async((resume) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
    let settled = false;

    const cleanup = () => {
      child.off('error', onError);
      child.off('exit', onExit);
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    };

    const settle = (effect) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resume(effect);
    };

    const onError = (cause) => {
      settle(Effect.fail(new CommandStartError({ command, cause })));
    };

    const onExit = (code, signal) => {
      settle(Effect.succeed({ code, signal }));
    };

    const onInterrupt = () => {
      child.kill('SIGINT');
    };

    const onTerminate = () => {
      child.kill('SIGTERM');
    };

    child.once('error', onError);
    child.once('exit', onExit);
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);

    return Effect.sync(() => {
      cleanup();
      if (!settled) {
        child.kill('SIGTERM');
      }
    });
  });
}

function commandExitCode(result) {
  if (result.code !== null) {
    return result.code;
  }

  if (result.signal === 'SIGINT') {
    return 130;
  }

  if (result.signal === 'SIGTERM') {
    return 143;
  }

  return 1;
}

function findPackagedRuntimeRoot() {
  const releaseRoot = resolve(desktopDirectory, 'release');
  if (!existsSync(releaseRoot)) throw new Error(`Package output is missing at ${releaseRoot}`);
  const matches = [];
  const visit = (directory, depth) => {
    if (depth > 8) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = resolve(directory, entry.name);
      if (entry.name === 'runtime' && existsSync(resolve(path, 'runtime-stage.json'))) {
        matches.push(path);
        continue;
      }
      visit(path, depth + 1);
    }
  };
  visit(releaseRoot, 0);
  matches.sort(
    (left, right) =>
      statSync(resolve(right, 'runtime-stage.json')).mtimeMs -
      statSync(resolve(left, 'runtime-stage.json')).mtimeMs,
  );
  if (!matches[0]) throw new Error(`No packaged runtime stage was found under ${releaseRoot}`);
  return matches[0];
}
