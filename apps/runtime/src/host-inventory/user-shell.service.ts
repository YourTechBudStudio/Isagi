import { spawn } from 'node:child_process';

import { Context, Effect, Layer } from 'effect';

import { backendLaunchCommand } from '../pty-processes/service/launch-mode.js';
import { userShellBaseEnv } from '../pty-processes/service/runtime-namespace.js';

const environmentProbeTimeoutMs = 5_000;
const environmentOutputLimitBytes = 128 * 1024;

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
  readonly environment: UserShellEnvironmentResult;
  readonly run: (command: UserShellCommand) => Effect.Effect<UserShellCommandResult>;
}

export type UserShellEnvironmentResult =
  | { readonly _tag: 'Available'; readonly values: NodeJS.ProcessEnv }
  | {
      readonly _tag: 'ProbeFailed';
      readonly values: NodeJS.ProcessEnv;
      readonly diagnostic: string;
    };

export const UserShell = Context.GenericTag<UserShellService>('isagi/UserShell');

export const UserShellLive = Layer.effect(
  UserShell,
  Effect.gen(function* () {
    const baseEnvironment = userShellBaseEnv();
    const environment = yield* resolveUserShellEnvironment(baseEnvironment);
    return {
      environment,
      run: (input) => runUserShellCommand(input, environment.values),
    } satisfies UserShellService;
  }),
);

export function resolveUserShellEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  run: typeof runUserShellCommand = runUserShellCommand,
) {
  const sanitizedBaseEnvironment = userShellBaseEnv(baseEnvironment);
  return run(
    {
      command: 'env',
      args: [],
      timeoutMs: environmentProbeTimeoutMs,
      maxOutputBytes: environmentOutputLimitBytes,
    },
    sanitizedBaseEnvironment,
  ).pipe(
    Effect.map((result): UserShellEnvironmentResult => {
      if (result.exitCode !== 0 || result.timedOut || result.outputTruncated || result.spawnError) {
        return {
          _tag: 'ProbeFailed',
          values: sanitizedBaseEnvironment,
          diagnostic: conciseFailure(result),
        };
      }
      return {
        _tag: 'Available',
        values: userShellBaseEnv(parseEnvironment(result.stdout)),
      };
    }),
  );
}

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

function parseEnvironment(stdout: string): NodeJS.ProcessEnv {
  return Object.fromEntries(
    stdout.split(/\r?\n/).flatMap((line) => {
      const separator = line.indexOf('=');
      return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
    }),
  );
}

function conciseFailure(result: UserShellCommandResult) {
  const detail =
    result.stderr.trim() || result.stdout.trim() || result.spawnError || 'Probe failed.';
  return detail.slice(0, 512);
}
