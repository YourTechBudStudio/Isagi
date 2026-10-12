import { Context, Duration, Effect, Layer, Option } from 'effect';

import { spawnProcessGroup } from './process-group.js';
import { userShellBaseEnv } from './shell-env.js';
import { shellLaunchCommand } from './shell-launch.js';

const environmentProbeTimeoutMs = 5_000;
const environmentOutputLimitBytes = 128 * 1024;

export interface UserShellCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/**
 * Everything a user-shell command produced. Never a failure: a command that could not start, exited non-zero, ran
 * past its deadline or wrote too much is described here, and the caller decides what that means.
 */
export interface UserShellCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The command ran past `timeoutMs`; its whole process group was `SIGKILL`ed. */
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
  readonly spawnError?: string | undefined;
}

export type UserShellEnvironmentResult =
  | { readonly _tag: 'Available'; readonly values: NodeJS.ProcessEnv }
  | {
      readonly _tag: 'ProbeFailed';
      readonly values: NodeJS.ProcessEnv;
      readonly diagnostic: string;
    };

const make = Effect.gen(function* () {
  const baseEnvironment = userShellBaseEnv();
  const environment = yield* resolveUserShellEnvironment(baseEnvironment);
  return UserShell.of({
    environment,
    run: Effect.fn('UserShell.run')(function* (input) {
      return yield* runUserShellCommand(input, environment.values);
    }),
  });
});

/**
 * The user's login-shell environment, probed once at startup, and a runner for short commands in that shell.
 *
 * A platform layer service: its live layer spawns the user's shell while the runtime starts, so tests always replace
 * it (`Layer.succeed(UserShell, UserShell.of({...}))`).
 */
export class UserShell extends Context.Service<
  UserShell,
  {
    readonly environment: UserShellEnvironmentResult;
    /**
     * Runs `command` through the user's shell as the leader of its own process group. The group is `SIGKILL`ed when
     * the command passes `timeoutMs` (reported as `timedOut`) or when the caller is interrupted, so nothing it started
     * outlives the call.
     */
    readonly run: (command: UserShellCommand) => Effect.Effect<UserShellCommandResult>;
  }
>()('isagi/runtime/platform/process/UserShell') {
  static readonly layer = Layer.effect(UserShell, make);
}

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

/** Exported for tests; production code calls `UserShell.run`, which supplies the probed environment. */
export const runUserShellCommand = Effect.fnUntraced(function* (
  input: UserShellCommand,
  environment: NodeJS.ProcessEnv,
) {
  const launch = shellLaunchCommand({
    launch: {
      command: input.command,
      args: input.args,
      launchMode: 'user_shell',
    },
    env: environment,
  });
  if (launch.fallback) {
    yield* Effect.logWarning('User-shell command fell back to a direct command').pipe(
      Effect.annotateLogs({ command: input.command, reason: launch.fallback }),
    );
  }
  const output = boundedOutput(input.maxOutputBytes);
  let timedOut = false;

  return yield* Effect.scoped(
    Effect.gen(function* () {
      // The scope owns the group: if this fiber is interrupted before the leader exits, the group is SIGKILLed.
      const group = yield* spawnProcessGroup({
        command: launch.command,
        args: launch.args,
        cwd: process.cwd(),
        env: environment,
        onOutput: output.append,
      });
      const settled = yield* Effect.timeoutOption(group.exit, Duration.millis(input.timeoutMs));
      if (Option.isSome(settled)) return settled.value;
      timedOut = true;
      yield* group.signal('SIGKILL');
      // Waits for `close`, so the result carries the kill signal and every chunk written before it.
      return yield* group.exit;
    }),
  ).pipe(
    Effect.map(
      (exit): UserShellCommandResult => ({
        exitCode: exit.exitCode,
        signal: exit.signal,
        ...output.text(),
        timedOut,
        outputTruncated: output.truncated(),
      }),
    ),
    Effect.catchTag('ProcessSpawnFailed', (error) =>
      Effect.succeed<UserShellCommandResult>({
        exitCode: null,
        signal: null,
        ...output.text(),
        timedOut,
        outputTruncated: output.truncated(),
        spawnError: spawnErrorMessage(error.cause),
      }),
    ),
  );
});

/** Keeps at most `limit` bytes per stream, remembering whether anything was dropped. */
function boundedOutput(limit: number) {
  const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  const bytes = { stdout: 0, stderr: 0 };
  let truncated = false;
  return {
    append: (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const remaining = Math.max(0, limit - bytes[stream]);
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) chunks[stream].push(chunk.subarray(0, remaining));
      bytes[stream] += Math.min(chunk.length, remaining);
    },
    text: () => ({
      stdout: Buffer.concat(chunks.stdout).toString('utf8'),
      stderr: Buffer.concat(chunks.stderr).toString('utf8'),
    }),
    truncated: () => truncated,
  };
}

/** The spawn error's own message (`spawn /bin/zsh ENOENT`), as the probe diagnostic has always reported it. */
function spawnErrorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
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
