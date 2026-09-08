import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { Data, Effect } from 'effect';

import { normalizeHomePath } from '../paths/path.utils.js';
import { gitMetadataOnPath } from './git-metadata.js';
import { Git, type GitCommandError } from './git.command.js';

export type ProjectPathValidationCode =
  | 'path_not_found'
  | 'not_directory'
  | 'not_git_repository'
  | 'not_repository_root'
  | 'linked_worktree_checkout'
  | 'bare_repository'
  | 'git_unavailable'
  | 'git_metadata_unreadable'
  | 'git_metadata_indeterminate'
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

export type ProjectRootClassification =
  | { readonly kind: 'git'; readonly rootPath: string; readonly name: string }
  | { readonly kind: 'folder'; readonly rootPath: string; readonly name: string };

/**
 * Pinned so probe stderr is git's own C-locale wording rather than a
 * translation. `LANGUAGE` is included because GNU gettext lets it override
 * `LC_ALL` for message selection. Applied to classification probes only —
 * nothing else the runtime spawns is affected.
 */
const CLASSIFICATION_ENV = { LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' } as const;

/**
 * Canonicalizes and stats the path without consulting Git, so a duplicate
 * registration can be detected before any subprocess runs.
 */
export function normalizeExistingDirectory(input: string) {
  return Effect.gen(function* () {
    const rootPath = normalizeProjectPath(input);
    yield* validateDirectory(rootPath);
    return { rootPath, name: basename(rootPath) || rootPath } satisfies ValidProjectRoot;
  });
}

/**
 * Decides whether a path is a supported Git root or an ordinary folder.
 *
 * Fail-closed by construction: `folder` is reachable through exactly one path —
 * git ran normally, exited 128, said "not a git repository" in its own C-locale
 * wording, *and* the filesystem shows no Git metadata at the path or above it.
 * Every other outcome refuses. Because a project's kind is immutable once
 * stored, a wrong `folder` verdict cannot be repaired later; a wrong refusal
 * costs the user one actionable error message.
 */
export function classifyProjectRoot(root: ValidProjectRoot) {
  return Effect.gen(function* () {
    const git = yield* Git;
    const probe = (args: readonly string[]) =>
      git.run(args, { env: CLASSIFICATION_ENV }).pipe(Effect.map(({ stdout }) => stdout.trim()));

    // Step 1. `--is-bare-repository` succeeds inside every supported layout
    // whenever git can read valid metadata, so "outside a repository" is one
    // unambiguous branch rather than a second string match.
    const bare = yield* probe(['-C', root.rootPath, 'rev-parse', '--is-bare-repository']).pipe(
      Effect.map((stdout) => ({ ok: true, stdout }) as const),
      Effect.catchAll((error) => Effect.succeed({ ok: false, error } as const)),
    );

    if (!bare.ok) {
      return yield* classifyAfterNegativeAnswer(bare.error, root);
    }
    if (bare.stdout === 'true') {
      return yield* Effect.fail(
        new ProjectPathValidationError({
          code: 'bare_repository',
          message: `That path is a bare Git repository, which has no working tree: ${root.rootPath}`,
          path: root.rootPath,
        }),
      );
    }
    if (bare.stdout !== 'false') {
      return yield* Effect.fail(
        unexpectedProbeOutput(root.rootPath, 'rev-parse --is-bare-repository'),
      );
    }

    // Step 2. Exact root equality. Validate the output before resolving it: an
    // empty string would normalize to the home directory.
    const topLevelRaw = yield* probe(['-C', root.rootPath, 'rev-parse', '--show-toplevel']).pipe(
      Effect.mapError((error) => operationalGitFailure(error, root.rootPath)),
    );
    if (topLevelRaw.length === 0) {
      return yield* Effect.fail(unexpectedProbeOutput(root.rootPath, 'rev-parse --show-toplevel'));
    }
    const topLevel = normalizeProjectPath(topLevelRaw);
    if (topLevel !== root.rootPath) {
      return yield* Effect.fail(
        new ProjectPathValidationError({
          code: 'not_repository_root',
          message: `Expected the repository root exactly, but ${root.rootPath} resolves inside ${topLevel}.`,
          path: root.rootPath,
        }),
      );
    }

    // Step 3. Unchanged linked-worktree and separate-git-dir restrictions.
    yield* rejectLinkedWorktree(root.rootPath, probe);

    return {
      kind: 'git',
      rootPath: root.rootPath,
      name: root.name,
    } satisfies ProjectRootClassification;
  });
}

export function validateProjectRoot(input: string) {
  return Effect.gen(function* () {
    const root = yield* normalizeExistingDirectory(input);
    const classification = yield* classifyProjectRoot(root);
    if (classification.kind === 'folder') {
      return yield* Effect.fail(
        new ProjectPathValidationError({
          code: 'not_git_repository',
          message: `Not a Git repository: ${root.rootPath}`,
          path: root.rootPath,
        }),
      );
    }
    return { rootPath: root.rootPath, name: root.name } satisfies ValidProjectRoot;
  });
}

/**
 * The single branch that can reach a `folder` verdict. A negative answer only
 * qualifies if git actually ran and refused in the ordinary way; anything else
 * — a launch failure, a signal, an abort, a trust or permission refusal, any
 * other exit code — leaves classification inconclusive.
 */
function classifyAfterNegativeAnswer(error: GitCommandError, root: ValidProjectRoot) {
  const isOrdinaryRefusal =
    error.failure.kind === 'exited' &&
    error.failure.exitCode === 128 &&
    /not a git repository/i.test(error.stderr);

  if (!isOrdinaryRefusal) {
    return Effect.fail(operationalGitFailure(error, root.rootPath));
  }

  const metadata = gitMetadataOnPath(root.rootPath);
  if (metadata.kind === 'present') {
    return Effect.fail(
      new ProjectPathValidationError({
        code: 'git_metadata_unreadable',
        cause: error,
        message: `Git data exists at ${metadata.path}, but Git refuses to read it.`,
        path: root.rootPath,
      }),
    );
  }
  if (metadata.kind === 'indeterminate') {
    return Effect.fail(
      new ProjectPathValidationError({
        code: 'git_metadata_indeterminate',
        cause: error,
        message: `Could not inspect ${metadata.path}, so whether Git is involved is unknown.`,
        path: root.rootPath,
      }),
    );
  }

  return Effect.succeed({
    kind: 'folder',
    rootPath: root.rootPath,
    name: root.name,
  } satisfies ProjectRootClassification);
}

/**
 * Maps a git failure that cannot produce a verdict. Distinguishing "git never
 * launched" from "git ran and failed" is the whole reason `GitCommandFailure`
 * exists: the old code labelled both `not_git_repository`, which is exactly the
 * guess that becomes unrecoverable once a folder kind can be stored.
 */
function operationalGitFailure(error: GitCommandError, path: string) {
  if (error.failure.kind === 'spawn_failed') {
    return new ProjectPathValidationError({
      code: 'git_unavailable',
      cause: error,
      message: `Could not run git${
        error.failure.systemErrorCode ? ` (${error.failure.systemErrorCode})` : ''
      } while inspecting ${path}.`,
      path,
    });
  }
  return new ProjectPathValidationError({
    code: 'git_command_failed',
    cause: error,
    message: `git ${error.args.join(' ')} failed${error.stderr ? `: ${error.stderr.trim()}` : ''}`,
    path,
  });
}

function unexpectedProbeOutput(path: string, probe: string) {
  return new ProjectPathValidationError({
    code: 'git_command_failed',
    message: `git ${probe} returned output this build does not recognize for ${path}.`,
    path,
  });
}

function rejectLinkedWorktree(
  rootPath: string,
  probe: (args: readonly string[]) => Effect.Effect<string, GitCommandError>,
) {
  return Effect.gen(function* () {
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

    const commonDir = yield* probe(['-C', rootPath, 'rev-parse', '--git-common-dir']).pipe(
      Effect.mapError((error) => operationalGitFailure(error, rootPath)),
    );
    if (commonDir.length === 0) {
      return yield* Effect.fail(unexpectedProbeOutput(rootPath, 'rev-parse --git-common-dir'));
    }
    const normalizedCommonDir = normalizeProjectPath(resolve(rootPath, commonDir));
    const expectedCommonDir = normalizeProjectPath(gitPath);
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

/**
 * Canonicalization for *user input*. Existing `projects.root_path` values were
 * stored through this exact behavior, so changing it would orphan them. It is
 * not a general path policy and `paths/path.utils.ts` is not a substitute — that
 * one does not realpath.
 */
export function normalizeProjectPath(input: string) {
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

function isPermissionError(error: unknown) {
  return (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'EACCES' ||
      (error as { code?: unknown }).code === 'EPERM')
  );
}
