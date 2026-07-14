import { spawn, type ChildProcessByStdio } from 'node:child_process';
import process from 'node:process';
import type { Readable } from 'node:stream';

export type RuntimeChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface RuntimeSpawnSpecification {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface RuntimeProcessAdapter {
  readonly spawn: (specification: RuntimeSpawnSpecification) => RuntimeChildProcess;
  readonly signal: (child: RuntimeChildProcess, signal: NodeJS.Signals) => void;
}

export const nodeRuntimeProcessAdapter: RuntimeProcessAdapter = {
  spawn: (specification) =>
    spawn(specification.command, [...specification.args], {
      cwd: specification.cwd,
      detached: process.platform !== 'win32',
      env: specification.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  signal: (child, signal) => {
    if (process.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if (!isMissingProcessError(error)) throw error;
        return;
      }
    }
    if (!child.killed) child.kill(signal);
  },
};

function isMissingProcessError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}
