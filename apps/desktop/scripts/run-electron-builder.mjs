import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Cause, Data, Effect, Exit } from 'effect';

class CommandStartError extends Data.TaggedError('CommandStartError') {}

const executableSuffix = process.platform === 'win32' ? '.cmd' : '';
const desktopDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const electronBuilderCommand = join(
  desktopDirectory,
  'node_modules',
  '.bin',
  `electron-builder${executableSuffix}`,
);

const program = Effect.gen(function* () {
  const packageResult = yield* runCommand(electronBuilderCommand, process.argv.slice(2));

  console.log('[desktop] Restoring better-sqlite3 for the standalone Node runtime');
  const restoreResult = yield* runCommand(`pnpm${executableSuffix}`, [
    '--filter',
    '@isagi/runtime',
    'rebuild',
    'better-sqlite3',
  ]);

  const packageExitCode = commandExitCode(packageResult);
  const restoreExitCode = commandExitCode(restoreResult);

  return packageExitCode !== 0 ? packageExitCode : restoreExitCode;
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
