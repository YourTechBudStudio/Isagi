import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';

import { Data, Effect } from 'effect';

export class ElectronPreparationError extends Data.TaggedError('ElectronPreparationError') {
  get message() {
    const location = this.path ? ` at ${this.path}` : '';
    return `Electron ${this.operation} failed${location}: ${errorMessage(this.cause)}`;
  }
}

export function prepareElectronExecutable({ desktopRoot, onPrepare = () => {} }) {
  return Effect.gen(function* () {
    const packageRoot = yield* tryOperation('package resolution', desktopRoot, () =>
      resolveElectronPackageRoot(desktopRoot),
    );
    const installed = yield* tryOperation('installation inspection', packageRoot, () =>
      readInstalledExecutable(packageRoot),
    );
    if (installed) return installed;

    yield* Effect.sync(onPrepare);
    yield* tryOperation('partial installation cleanup', packageRoot, () => {
      rmSync(resolve(packageRoot, 'dist'), { recursive: true, force: true });
      rmSync(resolve(packageRoot, 'path.txt'), { force: true });
    });
    yield* runInstaller(packageRoot);

    const executable = yield* tryOperation('installation validation', packageRoot, () =>
      readInstalledExecutable(packageRoot),
    );
    if (!executable) {
      return yield* Effect.fail(
        new ElectronPreparationError({
          operation: 'installation validation',
          path: packageRoot,
          cause: new Error('installer completed without producing an executable'),
        }),
      );
    }
    return executable;
  });
}

function resolveElectronPackageRoot(desktopRoot) {
  const require = createRequire(resolve(desktopRoot, 'package.json'));
  return dirname(require.resolve('electron'));
}

function readInstalledExecutable(packageRoot) {
  const marker = resolve(packageRoot, 'path.txt');
  if (!existsSync(marker)) return undefined;
  const relativeExecutable = readFileSync(marker, 'utf8');
  if (!relativeExecutable || isAbsolute(relativeExecutable)) return undefined;
  const dist = resolve(packageRoot, 'dist');
  const executable = resolve(dist, relativeExecutable);
  const fromDist = relative(dist, executable);
  if (!fromDist || fromDist.startsWith('..') || isAbsolute(fromDist)) return undefined;
  if (!existsSync(executable) || !statSync(executable).isFile()) return undefined;
  try {
    accessSync(executable, constants.X_OK);
  } catch {
    return undefined;
  }
  return executable;
}

function runInstaller(packageRoot) {
  const installer = resolve(packageRoot, 'install.js');
  return Effect.async((resumeEffect) => {
    const child = spawn(process.execPath, [installer, '--no'], {
      cwd: packageRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const settle = (effect) => {
      if (settled) return;
      settled = true;
      resumeEffect(effect);
    };
    child.once('error', (cause) =>
      settle(
        Effect.fail(
          new ElectronPreparationError({
            operation: 'installer start',
            path: installer,
            cause,
          }),
        ),
      ),
    );
    child.once('exit', (exitCode, signal) => {
      if (exitCode === 0) {
        settle(Effect.void);
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${exitCode}`;
      const output = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
      settle(
        Effect.fail(
          new ElectronPreparationError({
            operation: 'installer command',
            path: installer,
            cause: new Error(`${detail}${output ? `\n${output}` : ''}`),
          }),
        ),
      );
    });

    return Effect.sync(() => {
      if (!settled) child.kill('SIGTERM');
    });
  });
}

function tryOperation(operation, path, attempt) {
  return Effect.try({
    try: attempt,
    catch: (cause) => new ElectronPreparationError({ operation, path, cause }),
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
