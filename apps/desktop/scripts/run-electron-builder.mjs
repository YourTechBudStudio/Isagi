import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Cause, Data, Effect, Fiber } from 'effect';

import {
  classifyPackagingRequest,
  normalizePackagingArguments,
  resolveApplicationRoot,
  unsupportedPackagingMessage,
} from './electron-builder-target.mjs';
import { prepareLinuxIconInput } from './linux-icon-set.mjs';
import { preflightMacRelease } from './macos-release-contract.mjs';
import { classifyProgramExit, signalExitCode } from './program-exit.mjs';
import { verifyRuntimeStageParity } from './runtime-stage/parity.mjs';
import { stageRoot } from './runtime-stage/paths.mjs';
import { smokeRuntimeStage } from './runtime-stage/smoke.mjs';
import { prepareRuntimeStage } from './runtime-stage/stage.mjs';
import { linuxReleaseContract, verifyLinuxRelease } from './verify-linux-release.mjs';
import { verifyMacRelease } from './verify-macos-release.mjs';
import { verifyUpdaterPackage } from './verify-updater-package.mjs';

class CommandStartError extends Data.TaggedError('CommandStartError') {}
class PackagedRuntimeMissingError extends Data.TaggedError('PackagedRuntimeMissingError') {}
class PackagedRuntimeParityError extends Data.TaggedError('PackagedRuntimeParityError') {}
class UpdaterPackageVerificationError extends Data.TaggedError('UpdaterPackageVerificationError') {}
class LinuxReleaseStagingError extends Data.TaggedError('LinuxReleaseStagingError') {}
class LinuxReleaseVerificationError extends Data.TaggedError('LinuxReleaseVerificationError') {}
class MacReleasePreflightError extends Data.TaggedError('MacReleasePreflightError') {}
class MacReleaseVerificationError extends Data.TaggedError('MacReleaseVerificationError') {}
class UnsupportedPackagingRequestError extends Data.TaggedError(
  'UnsupportedPackagingRequestError',
) {}

const executableSuffix = process.platform === 'win32' ? '.cmd' : '';
const desktopDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const electronBuilderCommand = join(
  desktopDirectory,
  'node_modules',
  '.bin',
  `electron-builder${executableSuffix}`,
);
const packagingArguments = normalizePackagingArguments(process.argv.slice(2));

const program = Effect.gen(function* () {
  // Reject an unshippable or unrecognized packaging request before anything is
  // built, so it can never leave a stable-named artifact behind unverified.
  const request = classifyPackagingRequest(packagingArguments);
  if (request.kind === 'unsupported') {
    return yield* new UnsupportedPackagingRequestError({
      message: unsupportedPackagingMessage(request.reason),
    });
  }
  const macPreflight =
    request.kind === 'mac-release'
      ? yield* Effect.try({
          try: () =>
            preflightMacRelease({
              architecture: request.architecture,
              env: process.env,
              hostArchitecture: process.arch,
              platform: process.platform,
            }),
          catch: (cause) => new MacReleasePreflightError({ cause }),
        })
      : undefined;
  if (request.kind === 'linux-release') {
    yield* Effect.try({
      try: () => prepareLinuxIconInput(),
      catch: (cause) => new LinuxReleaseStagingError({ cause }),
    });
  }
  yield* prepareRuntimeStage();
  const packageResult = yield* runCommand(electronBuilderCommand, [
    ...packagingArguments,
    '--config',
    builderConfiguration(request),
  ]);
  const packageExitCode = commandExitCode(packageResult);
  if (packageExitCode !== 0) return packageExitCode;

  const releaseRoot = resolve(desktopDirectory, 'release');
  const applicationRoot = yield* Effect.try({
    try: () => resolveApplicationRoot(request, releaseRoot),
    catch: (cause) => new PackagedRuntimeMissingError({ cause }),
  });
  const packagedRuntimeRoot = join(packagedResourcesRoot(applicationRoot), 'runtime');
  if (request.kind !== 'mac-release') {
    const parity = yield* Effect.try({
      try: () => verifyRuntimeStageParity(stageRoot, packagedRuntimeRoot),
      catch: (cause) => new PackagedRuntimeParityError({ cause }),
    });
    console.log(
      `[desktop] Runtime stage parity passed (${parity.byteFileCount} byte-matched files, ${parity.executableFileCount} executable helpers, ${Object.keys(parity.dependencyVersions).length} exact external dependencies)`,
    );
    yield* smokeRuntimeStage(packagedRuntimeRoot);
  }
  const updaterVerification = yield* Effect.tryPromise({
    try: () =>
      verifyUpdaterPackage({
        asarPath: join(packagedResourcesRoot(applicationRoot), 'app.asar'),
        sourceRoot: join(desktopDirectory, 'src'),
      }),
    catch: (cause) => new UpdaterPackageVerificationError({ cause }),
  });
  console.log(
    `[desktop] Updater package verification passed (${updaterVerification.loadSiteCount} load site, ${updaterVerification.dependencyCount} production dependencies, ${updaterVerification.archiveEntryCount} archive entries)`,
  );
  if (request.kind === 'linux-release') {
    const installerPath = join(releaseRoot, linuxReleaseContract.installerName);
    yield* Effect.try({
      try: () => {
        copyFileSync(join(desktopDirectory, 'scripts/install-isagi-linux.sh'), installerPath);
        chmodSync(installerPath, 0o755);
      },
      catch: (cause) => new LinuxReleaseStagingError({ cause }),
    });
    const manifest = JSON.parse(readFileSync(join(desktopDirectory, 'package.json'), 'utf8'));
    const linuxVerification = yield* Effect.tryPromise({
      try: () =>
        verifyLinuxRelease({
          expectedVersion: manifest.version,
          releaseDirectory: releaseRoot,
        }),
      catch: (cause) => new LinuxReleaseVerificationError({ cause }),
    });
    console.log(
      `[desktop] Linux release verification passed (${linuxVerification.appImageSize} bytes, ${linuxVerification.iconSizes.length} icon frames, ${linuxVerification.elfPayloadCount} x86-64 ELF payloads, ${linuxVerification.licenseFileCount} license files, blockmap ${linuxVerification.blockMapSize} bytes)`,
    );
  }
  if (request.kind === 'mac-release') {
    const manifest = JSON.parse(readFileSync(join(desktopDirectory, 'package.json'), 'utf8'));
    const macVerification = yield* verifyMacRelease({
      architecture: request.architecture,
      expectedTeamId: macPreflight.expectedTeamId,
      expectedVersion: manifest.version,
      releaseDirectory: resolve(releaseRoot, `mac-${request.architecture}`),
    }).pipe(Effect.mapError((cause) => new MacReleaseVerificationError({ cause })));
    console.log(
      `[desktop] macOS ${request.architecture} release verification passed (${macVerification.artifactCount} artifacts, ${macVerification.nativePayloadCount} native payloads, ${macVerification.iconSizes.length} icon sizes, ${macVerification.licenseFileCount} license files)`,
    );
  }
  return 0;
});

// The first termination signal interrupts the program instead of killing the
// process, so scoped finalizers — notably DMG detachment and temporary-tree
// removal during post-build verification — still run. A second signal abandons
// that cleanup rather than letting a stuck finalizer trap the operator.
const fiber = Effect.runFork(program);
let receivedSignal;

const onSignal = (signal) => {
  if (receivedSignal) {
    process.exit(signalExitCode(signal));
  }
  receivedSignal = signal;
  console.error(`[desktop] ${signal} received; unwinding packaging before exit`);
  Effect.runFork(Fiber.interrupt(fiber));
};

const onInterruptSignal = () => onSignal('SIGINT');
const onTerminateSignal = () => onSignal('SIGTERM');
process.on('SIGINT', onInterruptSignal);
process.on('SIGTERM', onTerminateSignal);

const exit = await Effect.runPromise(Fiber.await(fiber));
process.off('SIGINT', onInterruptSignal);
process.off('SIGTERM', onTerminateSignal);

const outcome = classifyProgramExit(exit, receivedSignal);
if (outcome.cause) console.error(Cause.pretty(outcome.cause, { renderErrorCause: true }));
process.exitCode = outcome.code;

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

function packagedResourcesRoot(applicationRoot) {
  return process.platform === 'darwin' || applicationRoot.endsWith('.app')
    ? join(applicationRoot, 'Contents', 'Resources')
    : join(applicationRoot, 'resources');
}

function builderConfiguration(request) {
  return resolve(
    desktopDirectory,
    request.kind === 'local-directory'
      ? 'electron-builder.local.yml'
      : request.kind === 'mac-release'
        ? 'electron-builder.mac-release.yml'
        : 'electron-builder.yml',
  );
}
