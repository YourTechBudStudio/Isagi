import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Context, Data, Effect, Layer } from 'effect';

const execFileAsync = promisify(execFile);

/**
 * Why a git command failed, derived once from the `execFile` rejection where the
 * evidence still exists. Callers that must not confuse "git said no" with "git
 * never ran" — project-root classification above all — branch on this rather
 * than on `stderr` text.
 */
export type GitCommandFailure =
  | { readonly kind: 'spawn_failed'; readonly systemErrorCode: string | null }
  | { readonly kind: 'exited'; readonly exitCode: number }
  | { readonly kind: 'signalled'; readonly signal: string }
  | { readonly kind: 'aborted' };

export class GitCommandError extends Data.TaggedError('GitCommandError')<{
  readonly args: readonly string[];
  readonly cause: unknown;
  readonly cwd: string | undefined;
  readonly failure: GitCommandFailure;
  readonly stderr: string;
}> {}

export interface GitService {
  readonly run: (
    args: readonly string[],
    options?: {
      readonly cwd?: string | undefined;
      /** Merged over `process.env` for this child only. */
      readonly env?: Readonly<Record<string, string>> | undefined;
    },
  ) => Effect.Effect<{ readonly stdout: string; readonly stderr: string }, GitCommandError>;
}

export const Git = Context.GenericTag<GitService>('isagi/Git');

export const GitLive = Layer.succeed(Git, {
  run: (args, options = {}) =>
    Effect.tryPromise({
      try: async (signal) => {
        const { stdout, stderr } = await execFileAsync('git', [...args], {
          cwd: options.cwd,
          encoding: 'utf8',
          env: options.env ? { ...process.env, ...options.env } : undefined,
          maxBuffer: 1024 * 1024,
          signal,
        });
        return { stdout, stderr };
      },
      catch: (cause) =>
        new GitCommandError({
          args,
          cause,
          cwd: options.cwd,
          failure: deriveGitCommandFailure(cause),
          stderr: errorWithStderr(cause),
        }),
    }),
} satisfies GitService);

/**
 * Precedence is deliberate and load-bearing: an abort is reported by name, a
 * killed child by `signal`, an ordinary refusal by a numeric `code`, and a
 * launch failure by a string `code`. Anything unrecognized falls into
 * `spawn_failed` with a null code — the conservative bucket, because it is the
 * one classification never treats as evidence of anything.
 *
 * Exported for direct testing of that precedence; deliberately not re-exported
 * through `git/index.ts`, since no consumer outside this module needs it.
 */
export function deriveGitCommandFailure(cause: unknown): GitCommandFailure {
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

function errorWithStderr(error: unknown) {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string') {
      return stderr;
    }
  }
  return '';
}
