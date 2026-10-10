import { execFile } from 'node:child_process';
import { constants } from 'node:os';
import { basename } from 'node:path';
import { promisify } from 'node:util';

import { Data, Duration, Effect } from 'effect';

import { describeSafely, safeSystemErrorCode, type SafeDiagnostic } from '../diagnostics/index.js';

const execFileAsync = promisify(execFile);

/**
 * Why a command failed, derived once from the `execFile` rejection where the evidence still exists. Callers that must
 * not confuse "the tool said no" with "the tool never ran" (Git project-root classification above all) branch on this
 * rather than on `stderr` text.
 */
export type ExecFailure =
  | { readonly kind: 'spawn_failed'; readonly systemErrorCode: string | null }
  | { readonly kind: 'exited'; readonly exitCode: number }
  | { readonly kind: 'signalled'; readonly signal: string }
  | { readonly kind: 'aborted' };

/**
 * A command that could not be started, exited non-zero, or was killed. `cause` is the raw `execFile` rejection and
 * `stdout`/`stderr` are whatever the child wrote before it ended; both may echo user data, so the message names only
 * the executable and the failure kind.
 *
 * Its safe diagnostic label is composed from the `failure` classification and the executable's base name only. It
 * never reads `message`, `args`, `cwd` or the output, and it ends the cause walk, because the raw rejection's own
 * message carries the full command line.
 */
export class ExecFailed
  extends Data.TaggedError('ExecFailed')<{
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string | undefined;
    readonly failure: ExecFailure;
    readonly stdout: string;
    readonly stderr: string;
    readonly cause: unknown;
  }>
  implements SafeDiagnostic
{
  override get message() {
    return `${this.command} ${describeExecFailure(this.failure)}`;
  }

  [describeSafely]() {
    return {
      label: `${basename(this.command)} ${describeExecFailureSafely(this.failure)}`,
      cause: null,
    };
  }
}

export interface ExecCommandOptions {
  readonly cwd?: string | undefined;
  /** Merged over the inherited `process.env` for this child only. `undefined` values are dropped by Node. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /**
   * Inherited variables removed before `env` is merged. For callers that must not be retargeted by the runtime's own
   * environment (`git -C <dir>` does not override an inherited `GIT_DIR`).
   */
  readonly unsetEnv?: readonly string[] | undefined;
  /** Largest stdout or stderr accepted before the child is killed; defaults to 1 MiB. */
  readonly maxBuffer?: number | undefined;
  /**
   * Kills the child with `SIGTERM` after this long (Node's `execFile` timeout). The failure is then `signalled`, the
   * same evidence a caller sees today; wrap the effect in `Effect.timeout` instead when a typed timeout is wanted.
   */
  readonly timeout?: Duration.Input | undefined;
}

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a short-lived command (no shell) and collects its UTF-8 output. `command` must be a literal executable name
 * authored at the call site (`git`, `tmux`, `ps`, `tar`): its base name is rendered into `ExecFailed`'s safe diagnostic. Interrupting the effect aborts the child (Node
 * sends `SIGTERM`), so a cancelled request never leaves the command running.
 *
 * Use `spawnProcessGroup` instead for commands that run a user-authored shell line or may start their own children.
 */
export const execCommand = Effect.fn('process.execCommand')(function* (
  command: string,
  args: readonly string[],
  options: ExecCommandOptions = {},
) {
  return yield* Effect.tryPromise({
    try: async (signal): Promise<ExecResult> => {
      const { stdout, stderr } = await execFileAsync(command, [...args], {
        cwd: options.cwd,
        encoding: 'utf8',
        env: options.env || options.unsetEnv ? childEnvironment(options) : undefined,
        maxBuffer: options.maxBuffer ?? 1024 * 1024,
        signal,
        timeout: options.timeout === undefined ? undefined : Duration.toMillis(options.timeout),
      });
      return { stdout, stderr };
    },
    catch: (cause) =>
      new ExecFailed({
        command,
        args,
        cwd: options.cwd,
        failure: classifyExecFailure(cause),
        stdout: outputOf(cause, 'stdout'),
        stderr: outputOf(cause, 'stderr'),
        cause,
      }),
  });
});

/**
 * Precedence is deliberate and load-bearing: an abort is reported by name, a killed child by `signal`, an ordinary
 * refusal by a numeric `code`, and a launch failure by a string `code`. Anything unrecognized falls into
 * `spawn_failed` with a null code — the conservative bucket, because it is the one classification never treated as
 * evidence of anything.
 *
 * Git's `GitCommandError.failure` is this classification, so it decides project-root classification too.
 */
export function classifyExecFailure(cause: unknown): ExecFailure {
  if (!cause || typeof cause !== 'object') {
    return { kind: 'spawn_failed', systemErrorCode: null };
  }

  const candidate = cause as { name?: unknown; signal?: unknown; code?: unknown };

  if (candidate.name === 'AbortError') {
    return { kind: 'aborted' };
  }
  if (typeof candidate.signal === 'string' && candidate.signal.length > 0) {
    return { kind: 'signalled', signal: candidate.signal };
  }
  if (typeof candidate.code === 'number') {
    return { kind: 'exited', exitCode: candidate.code };
  }
  if (typeof candidate.code === 'string' && candidate.code.length > 0) {
    return { kind: 'spawn_failed', systemErrorCode: candidate.code };
  }
  return { kind: 'spawn_failed', systemErrorCode: null };
}

function describeExecFailure(failure: ExecFailure) {
  switch (failure.kind) {
    case 'spawn_failed':
      return `could not be started${failure.systemErrorCode ? ` (${failure.systemErrorCode})` : ''}`;
    case 'exited':
      return `exited with code ${failure.exitCode}`;
    case 'signalled':
      return `was killed by ${failure.signal}`;
    case 'aborted':
      return 'was aborted';
  }
}

/**
 * `describeExecFailure` under the safe-diagnostic rules: a spawn code appears only when it is on the system-error
 * allowlist, and a signal only when it is one of this platform's signal names. Both come from Node today; the checks
 * keep that an invariant of the label rather than an assumption about the cause.
 */
function describeExecFailureSafely(failure: ExecFailure) {
  switch (failure.kind) {
    case 'spawn_failed': {
      const code = safeSystemErrorCode(failure.systemErrorCode);
      return `could not be started${code ? ` (${code})` : ''}`;
    }
    case 'exited':
      return Number.isSafeInteger(failure.exitCode)
        ? `exited with code ${failure.exitCode}`
        : 'exited with a non-zero code';
    case 'signalled':
      return Object.hasOwn(constants.signals, failure.signal)
        ? `was killed by ${failure.signal}`
        : 'was killed by a signal';
    case 'aborted':
      return 'was aborted';
  }
}

function childEnvironment(options: ExecCommandOptions) {
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  for (const name of options.unsetEnv ?? []) delete inherited[name];
  return { ...inherited, ...options.env };
}

function outputOf(cause: unknown, stream: 'stdout' | 'stderr') {
  if (cause && typeof cause === 'object' && stream in cause) {
    const output = (cause as Record<string, unknown>)[stream];
    if (typeof output === 'string') return output;
  }
  return '';
}
