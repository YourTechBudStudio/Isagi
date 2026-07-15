import { spawn, type ChildProcessByStdio } from 'node:child_process';
import process from 'node:process';
import type { Readable } from 'node:stream';

export type RuntimeChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface RuntimeSpawnSpecification {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly processGroupOwnership: 'self' | 'external';
}

export interface RuntimeProcessAdapter {
  readonly spawn: (specification: RuntimeSpawnSpecification) => RuntimeChildProcess;
  readonly signal: (child: RuntimeChildProcess, signal: NodeJS.Signals) => void;
}

const processGroupOwnership = new WeakMap<RuntimeChildProcess, 'self' | 'external'>();

export const nodeRuntimeProcessAdapter: RuntimeProcessAdapter = {
  spawn: (specification) => {
    const child = spawn(specification.command, [...specification.args], {
      cwd: specification.cwd,
      detached: ownsRuntimeProcessGroup(process.platform, specification.processGroupOwnership),
      env: specification.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    processGroupOwnership.set(child, specification.processGroupOwnership);
    return child;
  },
  signal: (child, signal) => {
    if (ownsRuntimeProcessGroup(process.platform, processGroupOwnership.get(child)) && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if (!isMissingProcessError(error)) throw error;
        return;
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill(signal);
    } catch (error) {
      if (!isMissingProcessError(error)) throw error;
    }
  },
};

export function ownsRuntimeProcessGroup(
  platform: NodeJS.Platform,
  ownership: 'self' | 'external' | undefined,
) {
  return platform !== 'win32' && ownership === 'self';
}

function isMissingProcessError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}
