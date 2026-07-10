import { spawn } from 'node:child_process';

import { Context, Effect, Layer } from 'effect';

import { backendLaunchCommand } from '../pty-processes/service/launch-mode.js';
import { userShellBaseEnv } from '../pty-processes/service/runtime-namespace.js';

export interface UserShellCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface UserShellCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
  readonly spawnError?: string | undefined;
}

export interface UserShellService {
  readonly baseEnvironment: NodeJS.ProcessEnv;
  readonly run: (command: UserShellCommand) => Effect.Effect<UserShellCommandResult>;
}

export const UserShell = Context.GenericTag<UserShellService>('isagi/UserShell');

export const UserShellLive = Layer.sync(UserShell, () => {
  const baseEnvironment = userShellBaseEnv();
  return {
    baseEnvironment,
    run: (input) => runUserShellCommand(input, baseEnvironment),
  } satisfies UserShellService;
});

export function runUserShellCommand(
  input: UserShellCommand,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<UserShellCommandResult> {
  return Effect.async((resume) => {
    const launch = backendLaunchCommand({
      launch: {
        command: input.command,
        args: input.args,
        cwd: process.cwd(),
        launchMode: 'user_shell',
      },
      env: environment,
    });
    const child = spawn(launch.command, launch.args, {
      cwd: process.cwd(),
      detached: process.platform !== 'win32',
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let completed = false;

    const append = (chunks: Buffer[], chunk: Buffer, currentBytes: number) => {
      const remaining = Math.max(0, input.maxOutputBytes - currentBytes);
      if (chunk.length > remaining) outputTruncated = true;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      return currentBytes + Math.min(chunk.length, remaining);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = append(stdout, chunk, stdoutBytes);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = append(stderr, chunk, stderrBytes);
    });

    const finish = (result: UserShellCommandResult) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      resume(Effect.succeed(result));
    };
    const output = () => ({
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    });
    child.once('error', (error) => {
      finish({
        exitCode: null,
        signal: null,
        ...output(),
        timedOut,
        outputTruncated,
        spawnError: error.message,
      });
    });
    child.once('close', (exitCode, signal) => {
      finish({ exitCode, signal, ...output(), timedOut, outputTruncated });
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, input.timeoutMs);
    timeout.unref();

    return Effect.sync(() => {
      if (!completed) killProcessTree(child.pid);
    });
  });
}

function killProcessTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
    else process.kill(pid, 'SIGKILL');
  } catch {
    // The process may have exited between the timeout/cancellation and cleanup.
  }
}
