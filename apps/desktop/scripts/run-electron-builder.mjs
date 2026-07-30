import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Cause, Data, Effect, Exit } from 'effect';

import { verifyRuntimeStageParity } from './runtime-stage/parity.mjs';
import { stageRoot } from './runtime-stage/paths.mjs';
import { smokeRuntimeStage } from './runtime-stage/smoke.mjs';
import { prepareRuntimeStage } from './runtime-stage/stage.mjs';
import { verifyUpdaterPackage } from './verify-updater-package.mjs';

class CommandStartError extends Data.TaggedError('CommandStartError') {}
class PackagedRuntimeMissingError extends Data.TaggedError('PackagedRuntimeMissingError') {}
class PackagedRuntimeParityError extends Data.TaggedError('PackagedRuntimeParityError') {}

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

  const applicationRoot = yield* Effect.try({
    try: () => resolveCurrentApplicationRoot(process.argv.slice(2)),
    catch: (cause) => new PackagedRuntimeMissingError({ cause }),
  });
  const packagedRuntimeRoot = join(packagedResourcesRoot(applicationRoot), 'runtime');
  const parity = yield* Effect.try({
    try: () => verifyRuntimeStageParity(stageRoot, packagedRuntimeRoot),
    catch: (cause) => new PackagedRuntimeParityError({ cause }),
  });
  console.log(
    `[desktop] Runtime stage parity passed (${parity.byteFileCount} byte-matched files, ${parity.executableFileCount} executable helpers, ${Object.keys(parity.dependencyVersions).length} exact external dependencies)`,
  );
  yield* smokeRuntimeStage(packagedRuntimeRoot);
  const updaterVerification = yield* Effect.tryPromise({
    try: () =>
      verifyUpdaterPackage({
        asarPath: join(packagedResourcesRoot(applicationRoot), 'app.asar'),
        sourceRoot: join(desktopDirectory, 'src'),
      }),
    catch: (cause) => new PackagedRuntimeParityError({ cause }),
  });
  console.log(
    `[desktop] Updater package verification passed (${updaterVerification.loadSiteCount} load site, ${updaterVerification.dependencyCount} production dependencies, ${updaterVerification.archiveEntryCount} archive entries)`,
  );
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

export function resolveCurrentApplicationRoot(
  args,
  platform = process.platform,
  architecture = process.arch,
) {
  const requestedPlatform = args.includes('--mac')
    ? 'darwin'
    : args.includes('--linux')
      ? 'linux'
      : platform;
  const requestedArchitecture = args.includes('--x64')
    ? 'x64'
    : args.includes('--arm64')
      ? 'arm64'
      : architecture;
  const releaseRoot = resolve(desktopDirectory, 'release');
  const root =
    requestedPlatform === 'darwin'
      ? join(releaseRoot, requestedArchitecture === 'arm64' ? 'mac-arm64' : 'mac', 'Isagi.app')
      : requestedPlatform === 'linux'
        ? join(
            releaseRoot,
            requestedArchitecture === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked',
          )
        : '';
  if (!root || !existsSync(root))
    throw new Error(`Current packaged application output is missing at ${root || releaseRoot}`);
  return root;
}

function packagedResourcesRoot(applicationRoot) {
  return process.platform === 'darwin' || applicationRoot.endsWith('.app')
    ? join(applicationRoot, 'Contents', 'Resources')
    : join(applicationRoot, 'resources');
}
