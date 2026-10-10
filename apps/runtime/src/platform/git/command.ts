import { Context, Data, Effect, Layer } from 'effect';

import { execCommand, type ExecFailure } from '../process/index.js';

/**
 * Why a git command failed, derived once by `platform/process`'s `classifyExecFailure` from the `execFile` rejection
 * where the evidence still exists. Callers that must not confuse "git said no" with "git never ran" — project-root
 * classification above all — branch on this rather than on `stderr` text.
 *
 * `aborted` stays in the union for completeness but is unreachable as a failure: interrupting `Git.run` (a client
 * disconnect, a timeout, shutdown) kills the child and interrupts the caller instead of failing it.
 */
export type GitCommandFailure = ExecFailure;

/**
 * A git command that could not be started, exited non-zero, or was killed. `cause` is the raw `execFile` rejection and
 * `stderr` whatever git wrote before it ended; both may echo user data.
 */
export class GitCommandError extends Data.TaggedError('GitCommandError')<{
  readonly args: readonly string[];
  readonly cause: unknown;
  readonly cwd: string | undefined;
  readonly failure: GitCommandFailure;
  readonly stderr: string;
}> {}

export interface GitRunOptions {
  readonly cwd?: string | undefined;
  /** Merged over `process.env` for this child only. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /**
   * Inherited variables removed before `env` is merged. For callers that must not be retargeted by
   * the runtime's own environment — `-C <dir>` does not override an inherited `GIT_DIR`.
   */
  readonly unsetEnv?: readonly string[] | undefined;
  /** Largest stdout or stderr accepted before the child is killed; defaults to 1 MiB. */
  readonly maxBuffer?: number | undefined;
}

/**
 * Runs `git` (no shell) through the shared `execCommand` adapter. Interrupting the effect kills the child, so a
 * cancelled request or an `Effect.timeout` around a call never leaves git running.
 */
const run = Effect.fn('Git.run')(function* (args: readonly string[], options: GitRunOptions = {}) {
  return yield* execCommand('git', args, {
    cwd: options.cwd,
    env: options.env,
    unsetEnv: options.unsetEnv,
    maxBuffer: options.maxBuffer,
  }).pipe(
    Effect.mapError(
      (error) =>
        new GitCommandError({
          args,
          cause: error.cause,
          cwd: options.cwd,
          failure: error.failure,
          stderr: error.stderr,
        }),
    ),
  );
});

export class Git extends Context.Service<
  Git,
  {
    readonly run: (
      args: readonly string[],
      options?: GitRunOptions,
    ) => Effect.Effect<{ readonly stdout: string; readonly stderr: string }, GitCommandError>;
  }
>()('isagi/runtime/platform/git/Git') {
  static readonly layer = Layer.succeed(Git, Git.of({ run }));
}
