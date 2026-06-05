import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { Data, Effect } from 'effect';

import { normalizeHomePath } from '../paths/path-utils.js';
import { Git, GitCommandError } from './git-command.js';
import { parseGitWorktreeListPorcelain, type GitWorktreeRecord } from './worktree-list.js';

export type ProjectPathValidationCode =
  | 'path_not_found'
  | 'not_directory'
  | 'not_git_repository'
  | 'not_repository_root'
  | 'linked_worktree_checkout'
  | 'permission_denied'
  | 'git_command_failed';

export class ProjectPathValidationError extends Data.TaggedError('ProjectPathValidationError')<{
  readonly code: ProjectPathValidationCode;
  readonly cause?: unknown;
  readonly message: string;
  readonly path: string;
}> {}

export interface ValidProjectRoot {
  readonly rootPath: string;
  readonly name: string;
}

export function validateProjectRoot(input: string) {
  return Effect.gen(function* () {
    const git = yield* Git;
    const rootPath = normalizeProjectPath(input);
    yield* validateDirectory(rootPath);

    const topLevel = yield* git.run(['-C', rootPath, 'rev-parse', '--show-toplevel']).pipe(
      Effect.map(({ stdout }) => normalizeProjectPath(stdout.trim())),
      Effect.mapError((error) => gitValidationError(error, rootPath, 'not_git_repository')),
    );

    if (topLevel !== rootPath) {
      return yield* Effect.fail(
        new ProjectPathValidationError({
          code: 'not_repository_root',
          message: `Expected the repository root exactly, but ${rootPath} resolves inside ${topLevel}.`,
          path: rootPath,
        }),
      );
    }

    yield* rejectLinkedWorktree(rootPath);

    return { rootPath, name: basename(rootPath) || rootPath } satisfies ValidProjectRoot;
  });
}

export function listGitWorktrees(rootPath: string) {
  return Effect.gen(function* () {
    const git = yield* Git;
    return yield* git
      .run(['-C', rootPath, 'worktree', 'list', '--porcelain'])
      .pipe(
        Effect.map(({ stdout }) => normalizeWorktreeRecords(parseGitWorktreeListPorcelain(stdout))),
      );
  });
}

function validateDirectory(path: string) {
  return Effect.try({
    try: () => {
      if (!existsSync(path)) {
        throw new ProjectPathValidationError({
          code: 'path_not_found',
          message: `Path not found: ${path}`,
          path,
        });
      }
      const stat = statSync(path);
      if (!stat.isDirectory()) {
        throw new ProjectPathValidationError({
          code: 'not_directory',
          message: `Path is not a directory: ${path}`,
          path,
        });
      }
    },
    catch: (error) => {
      if (error instanceof ProjectPathValidationError) {
        return error;
      }
      if (isPermissionError(error)) {
        return new ProjectPathValidationError({
          code: 'permission_denied',
          cause: error,
          message: `Permission denied while reading ${path}.`,
          path,
        });
      }
      return new ProjectPathValidationError({
        code: 'path_not_found',
        cause: error,
        message: `Could not inspect path ${path}.`,
        path,
      });
    },
  });
}

function rejectLinkedWorktree(rootPath: string) {
  return Effect.gen(function* () {
    const git = yield* Git;
    const gitPath = join(rootPath, '.git');
    const isGitDirectory = existsSync(gitPath) && statSync(gitPath).isDirectory();
    if (!isGitDirectory) {
      return yield* Effect.fail(
        new ProjectPathValidationError({
          code: 'linked_worktree_checkout',
          message:
            'That path looks like a linked Git worktree. Add the main/root checkout path instead.',
          path: rootPath,
        }),
      );
    }

    const commonDir = yield* git.run(['-C', rootPath, 'rev-parse', '--git-common-dir']).pipe(
      Effect.map(({ stdout }) => stdout.trim()),
      Effect.mapError((error) => gitValidationError(error, rootPath, 'git_command_failed')),
    );
    const normalizedCommonDir = normalizeProjectPath(resolve(rootPath, commonDir));
    const expectedCommonDir = normalizeProjectPath(join(rootPath, '.git'));
    if (normalizedCommonDir !== expectedCommonDir) {
      return yield* Effect.fail(
        new ProjectPathValidationError({
          code: 'linked_worktree_checkout',
          message:
            'That path resolves to a linked Git worktree. Add the main/root checkout path instead.',
          path: rootPath,
        }),
      );
    }
  });
}

function gitValidationError(
  error: GitCommandError,
  path: string,
  fallback: ProjectPathValidationCode,
) {
  if (error.stderr.includes('not a git repository')) {
    return new ProjectPathValidationError({
      code: 'not_git_repository',
      cause: error,
      message: `Not a Git repository: ${path}`,
      path,
    });
  }
  return new ProjectPathValidationError({
    code: fallback,
    cause: error,
    message: `git ${error.args.join(' ')} failed${error.stderr ? `: ${error.stderr.trim()}` : ''}`,
    path,
  });
}

function normalizeProjectPath(input: string) {
  const trimmed = input.trim();
  const expanded = trimmed.startsWith('~')
    ? normalizeHomePath(trimmed)
    : isAbsolute(trimmed)
      ? resolve(trimmed)
      : resolve(homedir(), trimmed);
  try {
    return realpathSync(expanded);
  } catch {
    return resolve(expanded);
  }
}

function normalizeWorktreeRecords(records: readonly GitWorktreeRecord[]) {
  return records.map((record) => ({
    ...record,
    path: normalizeProjectPath(record.path),
  }));
}

function isPermissionError(error: unknown) {
  return (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'EACCES' ||
      (error as { code?: unknown }).code === 'EPERM')
  );
}
