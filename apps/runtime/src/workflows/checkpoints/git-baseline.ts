/**
 * What Git knows about a checkpoint's destination: the base commit, the files that commit tracks
 * under the covered roots, and which paths are dirty.
 *
 * Two kinds of read live here and they fail differently. HEAD, the object format and the base tree
 * are load-bearing — a checkpoint recorded against a HEAD or tree the runtime could not read would
 * silently reconstruct the wrong thing — so their failures refuse the capture. The dirty survey only
 * informs warnings, so it never fails: it degrades to `{ ok: false }` and the checkpoint says so.
 *
 * Every call runs `git -C <worktree>` under the C locale with a 16 MiB output bound. Roots are
 * passed as `:(literal)` pathspecs so a directory named `*` or `[a]` means only itself.
 */

import { Effect } from 'effect';

import type { GitCommandError, GitService } from '../../git/git.command.js';
import { CheckpointCaptureFailure } from './failure.js';
import { pathContains } from './plan.js';
import type { BaseTreeEntry, DirtyEntry } from './types.js';

const gitEnv = {
  LC_ALL: 'C',
  LANG: 'C',
  LANGUAGE: 'C',
  // `status` refreshes the index as a side effect when it can take the lock; a capture must never
  // contend with, or be blocked by, whatever else is using the repository.
  GIT_OPTIONAL_LOCKS: '0',
} as const;
/**
 * Inherited variables that would point `git -C <worktree>` at some other repository, index or object
 * store. A checkpoint records a HEAD and tree beside bytes read from the destination, so its Git
 * reads must describe that destination whatever environment the runtime was started in.
 */
const repositoryTargetingEnv = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
] as const;
const maxBuffer = 16 * 1024 * 1024;
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface GitBaseline {
  /** The full commit sha, or null for a repository with no commit yet. */
  readonly head: string | null;
  readonly objectFormat: 'sha1' | 'sha256';
}

export type DirtySurvey =
  | { readonly ok: true; readonly entries: readonly DirtyEntry[] }
  | { readonly ok: false };

function runGit(git: GitService, worktreePath: string, args: readonly string[]) {
  return git.run(['-C', worktreePath, ...args], {
    env: gitEnv,
    unsetEnv: repositoryTargetingEnv,
    maxBuffer,
  });
}

function loadBearing(error: GitCommandError, what: string): CheckpointCaptureFailure {
  return error.failure.kind === 'spawn_failed'
    ? new CheckpointCaptureFailure({
        reason: 'git_unavailable',
        message: `Git could not be started to ${what}.`,
        cause: error,
      })
    : new CheckpointCaptureFailure({
        reason: 'git_inspection_failed',
        message: `Git could not ${what}.`,
        cause: error,
      });
}

const literal = (path: string) => `:(literal)${path}`;

/** Split NUL-terminated output, dropping the empty tail after the last terminator. */
function records(stdout: string): string[] {
  const parts = stdout.split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

/**
 * HEAD as `sha | null`. Null means an unborn branch: `rev-parse` found no commit *and* HEAD is a
 * symbolic ref. Anything else — a detached HEAD pointing nowhere, corrupt metadata, odd output — is
 * a failed read, never "no commit", because an `unborn_repository` base reconstructs from nothing.
 */
export function readHead(
  git: GitService,
  worktreePath: string,
): Effect.Effect<string | null, CheckpointCaptureFailure> {
  const what = 'read HEAD';
  return Effect.gen(function* () {
    const found = yield* runGit(git, worktreePath, [
      'rev-parse',
      '--verify',
      '--quiet',
      'HEAD^{commit}',
    ]).pipe(
      Effect.map(({ stdout }) => stdout.trim()),
      Effect.catchIf(
        (error) => error.failure.kind === 'exited' && error.failure.exitCode === 1,
        () => runGit(git, worktreePath, ['symbolic-ref', '--quiet', 'HEAD']).pipe(Effect.as(null)),
      ),
      Effect.mapError((error) => loadBearing(error, what)),
    );
    if (found === null) return null;
    if (!commitPattern.test(found)) {
      return yield* new CheckpointCaptureFailure({
        reason: 'git_inspection_failed',
        message: `Git answered ${what} with an unrecognized commit id.`,
      });
    }
    return found;
  });
}

export function inspectBaseline(
  git: GitService,
  worktreePath: string,
): Effect.Effect<GitBaseline, CheckpointCaptureFailure> {
  return Effect.gen(function* () {
    const head = yield* readHead(git, worktreePath);
    const { stdout } = yield* runGit(git, worktreePath, ['rev-parse', '--show-object-format']).pipe(
      Effect.mapError((error) => loadBearing(error, 'read the object format')),
    );
    const objectFormat = stdout.trim();
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
      return yield* new CheckpointCaptureFailure({
        reason: 'git_inspection_failed',
        message: `Git reported an unsupported object format: ${objectFormat}.`,
      });
    }
    return { head, objectFormat };
  });
}

/**
 * Every regular file (`100644`/`100755`) the commit tracks under `roots`, each root taken literally
 * under its own spelling. Links and submodules are dropped: they are outside the reconstruction
 * guarantee and so are never absence candidates. Paths are deduplicated across overlapping roots.
 */
export function listBaseTree(
  git: GitService,
  worktreePath: string,
  sha: string,
  roots: readonly string[],
): Effect.Effect<readonly BaseTreeEntry[], CheckpointCaptureFailure> {
  if (roots.length === 0) return Effect.succeed([]);
  return runGit(git, worktreePath, [
    'ls-tree',
    '-r',
    '-z',
    sha,
    '--',
    ...[...new Set(roots)].map(literal),
  ]).pipe(
    Effect.mapError((error) => loadBearing(error, 'list the base tree')),
    Effect.flatMap(({ stdout }) => {
      const entries = new Map<string, BaseTreeEntry>();
      for (const record of records(stdout)) {
        const parsed = parseTreeRecord(record);
        if (parsed === null) {
          return Effect.fail(
            new CheckpointCaptureFailure({
              reason: 'git_inspection_failed',
              message: 'Git listed the base tree in an unrecognized format.',
            }),
          );
        }
        if (parsed.mode !== '100644' && parsed.mode !== '100755') continue;
        entries.set(parsed.path, {
          path: parsed.path,
          objectId: parsed.objectId,
          executable: parsed.mode === '100755',
        });
      }
      return Effect.succeed([...entries.values()]);
    }),
  );
}

/**
 * The entry names of one level of the base tree, of any type. `parent` is a root-relative tree path
 * in the base's spelling, or `''` for the top level. Used only to find a base spelling that an
 * existing on-disk root aliases (`Apps` in the commit, `apps` on disk).
 */
export function listBaseLevel(
  git: GitService,
  worktreePath: string,
  sha: string,
  parent: string,
): Effect.Effect<readonly string[], CheckpointCaptureFailure> {
  const pathspec = parent === '' ? [] : ['--', literal(`${parent}/`)];
  return runGit(git, worktreePath, ['ls-tree', '-z', sha, ...pathspec]).pipe(
    Effect.mapError((error) => loadBearing(error, 'list the base tree')),
    Effect.flatMap(({ stdout }) => {
      const names: string[] = [];
      for (const record of records(stdout)) {
        const parsed = parseTreeRecord(record);
        if (parsed === null) {
          return Effect.fail(
            new CheckpointCaptureFailure({
              reason: 'git_inspection_failed',
              message: 'Git listed the base tree in an unrecognized format.',
            }),
          );
        }
        names.push(parsed.path.slice(parsed.path.lastIndexOf('/') + 1));
      }
      return Effect.succeed(names);
    }),
  );
}

function parseTreeRecord(
  record: string,
): { readonly mode: string; readonly objectId: string; readonly path: string } | null {
  const tab = record.indexOf('\t');
  if (tab === -1) return null;
  const [mode, type, objectId] = record.slice(0, tab).split(' ');
  const path = record.slice(tab + 1);
  if (!mode || !type || !objectId || path.length === 0) return null;
  return { mode, objectId, path };
}

/**
 * Dirty paths, for warnings only. `--untracked-files=normal` collapses an untracked directory to one
 * `dir/` entry; a collapsed directory that intersects one of `regions` is expanded once, so an
 * uncaptured sibling of a captured region is never hidden behind its parent. Ignored paths are never
 * listed. Any failure, including output beyond the buffer, is `{ ok: false }`.
 */
export function surveyDirtyPaths(
  git: GitService,
  worktreePath: string,
  regions: readonly { readonly path: string }[],
): Effect.Effect<DirtySurvey, never> {
  const status = (extra: readonly string[]) =>
    runGit(git, worktreePath, ['status', '--porcelain=v1', '-z', '--no-renames', ...extra]).pipe(
      Effect.map(({ stdout }) => parseStatus(stdout)),
    );
  return Effect.gen(function* () {
    const survey = yield* status(['--untracked-files=normal']);
    if (survey === null) return { ok: false } as const;
    const entries: DirtyEntry[] = [];
    for (const entry of survey) {
      const directory = entry.path.slice(0, -1);
      const intersects =
        entry.collapsedDirectory &&
        regions.some(
          (region) => pathContains(directory, region.path) || pathContains(region.path, directory),
        );
      if (!intersects) {
        entries.push(entry);
        continue;
      }
      const expanded = yield* status(['--untracked-files=all', '--', literal(directory)]);
      if (expanded === null) return { ok: false } as const;
      entries.push(...expanded.filter((inner) => pathContains(directory, inner.path)));
    }
    return { ok: true, entries } as const;
  }).pipe(Effect.catchAll(() => Effect.succeed({ ok: false } as const)));
}

/**
 * `XY <path>\0` per entry; with `--no-renames` no entry carries a second path. The path keeps Git's
 * spelling, including a collapsed directory's trailing `/`. Null for output that is not this shape.
 */
function parseStatus(stdout: string): DirtyEntry[] | null {
  const entries: DirtyEntry[] = [];
  for (const record of records(stdout)) {
    if (record.length < 4 || record[2] !== ' ') return null;
    const path = record.slice(3);
    entries.push({ path, collapsedDirectory: path.endsWith('/') });
  }
  return entries;
}
