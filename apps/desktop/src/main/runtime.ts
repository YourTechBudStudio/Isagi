import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import type { Readable } from 'node:stream';

import { app } from 'electron';

const readyPrefix = 'ISAGI_RUNTIME_READY ';

let runtimeProcess: ChildProcessByStdio<null, Readable, Readable> | undefined;
let runtimeUrlPromise: Promise<string> | undefined;

export function getRuntimeUrl() {
  if (process.env.ISAGI_RUNTIME_URL) {
    return Promise.resolve(process.env.ISAGI_RUNTIME_URL);
  }

  runtimeUrlPromise ??= spawnRuntimeAndWaitForUrl();

  return runtimeUrlPromise;
}

export function stopRuntime() {
  if (runtimeProcess && !runtimeProcess.killed) {
    runtimeProcess.kill();
  }
}

function spawnRuntimeAndWaitForUrl() {
  return new Promise<string>((resolve, reject) => {
    const childProcess = spawnRuntimeProcess();
    runtimeProcess = childProcess;

    const timeout = setTimeout(() => {
      reject(new Error('Runtime did not report readiness within 15 seconds'));
    }, 15_000);

    const cleanup = () => {
      clearTimeout(timeout);
      childProcess.stdout.off('data', onStdout);
      childProcess.stderr.off('data', onStderr);
      childProcess.off('error', onError);
      childProcess.off('exit', onExit);
    };

    const resolveReadyLine = (line: string) => {
      if (!line.startsWith(readyPrefix)) {
        return;
      }

      const payload = JSON.parse(line.slice(readyPrefix.length)) as { url?: unknown };

      if (typeof payload.url !== 'string') {
        throw new Error('Runtime readiness payload did not include a URL');
      }

      cleanup();
      resolve(payload.url);
    };

    let stdoutBuffer = '';

    const onStdout = (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        try {
          resolveReadyLine(line.trim());
        } catch (error) {
          cleanup();
          reject(error);
        }
      }
    };

    const onStderr = (chunk: Buffer) => {
      console.error(`[runtime] ${chunk.toString('utf8').trim()}`);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Runtime exited before readiness: code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        ),
      );
    };

    childProcess.stdout.on('data', onStdout);
    childProcess.stderr.on('data', onStderr);
    childProcess.once('error', onError);
    childProcess.once('exit', onExit);
  });
}

function spawnRuntimeProcess() {
  if (process.env.ISAGI_RUNTIME_COMMAND) {
    return spawn(process.env.ISAGI_RUNTIME_COMMAND, {
      env: process.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  if (app.isPackaged) {
    return spawn(process.execPath, [join(process.resourcesPath, 'runtime/index.js')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  return spawn(pnpmCommand(), ['--filter', '@isagi/runtime', 'dev'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function pnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}
