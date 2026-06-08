import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Context, Data, Effect, Layer } from 'effect';

const execFileAsync = promisify(execFile);

export class GitCommandError extends Data.TaggedError('GitCommandError')<{
  readonly args: readonly string[];
  readonly cause: unknown;
  readonly cwd: string | undefined;
  readonly stderr: string;
}> {}

export interface GitService {
  readonly run: (
    args: readonly string[],
    options?: { readonly cwd?: string | undefined },
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
          stderr: errorWithStderr(cause),
        }),
    }),
} satisfies GitService);

function errorWithStderr(error: unknown) {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string') {
      return stderr;
    }
  }
  return '';
}
