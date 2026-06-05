import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import type { Readable } from 'node:stream';

import { Duration, Effect, Fiber } from 'effect';
import { app } from 'electron';

const readyPrefix = 'ISAGI_RUNTIME_READY ';

let runtimeProcess: ChildProcessByStdio<null, Readable, Readable> | undefined;
let runtimeUrlFiber: Fiber.RuntimeFiber<string, Error> | undefined;

export function getRuntimeUrl() {
  if (process.env.ISAGI_RUNTIME_URL) {
    return Effect.succeed(process.env.ISAGI_RUNTIME_URL);
  }

  runtimeUrlFiber ??= Effect.runFork(spawnRuntimeAndWaitForUrl());

  return Fiber.join(runtimeUrlFiber).pipe(
    Effect.tapError(() =>
      Effect.sync(() => {
        runtimeUrlFiber = undefined;
      }),
    ),
  );
}

export function stopRuntime() {
  if (runtimeUrlFiber) {
    Effect.runFork(Fiber.interrupt(runtimeUrlFiber));
    runtimeUrlFiber = undefined;
  }

  if (runtimeProcess) {
    killRuntimeProcess(runtimeProcess);
    runtimeProcess = undefined;
  }
}

function spawnRuntimeAndWaitForUrl() {
  return Effect.async<string, Error>((resume) => {
    const childProcess = spawnRuntimeProcess();
    runtimeProcess = childProcess;
    let stdoutBuffer = '';
    let settled = false;

    const cleanup = () => {
      childProcess.stdout.off('data', onStdout);
      childProcess.stderr.off('data', onStderr);
      childProcess.off('error', onError);
      childProcess.off('exit', onExit);
    };

    const resetSpawnState = () => {
      if (runtimeProcess === childProcess) {
        runtimeProcess = undefined;
      }

      runtimeUrlFiber = undefined;
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      killRuntimeProcess(childProcess);
      resetSpawnState();
      resume(Effect.fail(error));
    };

    const succeed = (url: string) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resume(Effect.succeed(url));
    };

    const abortSpawn = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resetSpawnState();

      killRuntimeProcess(childProcess);
    };

    const resolveReadyLine = (line: string) => {
      if (!line.startsWith(readyPrefix)) {
        return;
      }

      const payload = JSON.parse(line.slice(readyPrefix.length)) as { url?: unknown };

      if (typeof payload.url !== 'string') {
        throw new Error('Runtime readiness payload did not include a URL');
      }

      succeed(payload.url);
    };

    const onStdout = (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        try {
          resolveReadyLine(line.trim());
        } catch (error) {
          fail(toError(error));
        }
      }
    };

    const onStderr = (chunk: Buffer) => {
      console.error(`[runtime] ${chunk.toString('utf8').trim()}`);
    };

    const onError = (error: Error) => {
      fail(error);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(
        new Error(
          `Runtime exited before readiness: code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        ),
      );
    };

    childProcess.stdout.on('data', onStdout);
    childProcess.stderr.on('data', onStderr);
    childProcess.once('error', onError);
    childProcess.once('exit', onExit);

    return Effect.sync(abortSpawn);
  }).pipe(
    Effect.timeoutFail({
      duration: Duration.seconds(15),
      onTimeout: () => new Error('Runtime did not report readiness within 15 seconds'),
    }),
  );
}

function spawnRuntimeProcess() {
  if (process.env.ISAGI_RUNTIME_COMMAND) {
    return spawn(process.env.ISAGI_RUNTIME_COMMAND, {
      detached: useDetachedRuntimeProcess(),
      env: process.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  if (app.isPackaged) {
    return spawn(process.execPath, [join(process.resourcesPath, 'app.asar/runtime/index.js')], {
      detached: useDetachedRuntimeProcess(),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  return spawn(pnpmCommand(), ['--filter', '@isagi/runtime', 'dev'], {
    detached: useDetachedRuntimeProcess(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function killRuntimeProcess(childProcess: ChildProcessByStdio<null, Readable, Readable>) {
  if (!childProcess.pid) {
    childProcess.kill();
    return;
  }

  if (useDetachedRuntimeProcess()) {
    try {
      process.kill(-childProcess.pid, 'SIGTERM');
      return;
    } catch (error) {
      if (!isMissingProcessError(error)) {
        console.error(`[runtime] Failed to kill runtime process group: ${toError(error).message}`);
      }
    }
  }

  if (!childProcess.killed) {
    childProcess.kill();
  }
}

function useDetachedRuntimeProcess() {
  return process.platform !== 'win32';
}

function isMissingProcessError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}

function pnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
