import { mkdirSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Data, Effect } from 'effect';

import type { WorktreeDestinationIssue } from '@isagi/contracts';

import { diagnosticPhase } from '../diagnostics/phase.js';
import { Git, type GitCommandError, type GitService, listGitWorktrees } from '../git/index.js';
import type { DatabaseError } from '../persistence/index.js';
import { directoryAvailability } from './directory-availability.js';
import { checkNewDirectory } from './new-directory.js';
import type { ProjectRow } from './types.js';
import type { WorkspaceRepositoryService } from './workspace.repository.js';

/**
 * Detached creation fails with its own tagged error rather than new `WorkspaceError` codes, for the
 * reason `ProjectOrderError` does: `WorkspaceError` is shared by endpoint mappers that end in a
 * catch-all default, so an unmapped code would be reported as some other failure. Callers switch on
 * `reason` exhaustively.
 */
export class DetachedWorktreeError extends Data.TaggedError('DetachedWorktreeError')<{
  readonly reason:
    | 'project_unavailable'
    | 'destination_rejected'
    | 'commit_not_found'
    | 'git_add_failed'
    | 'registration_failed';
  readonly message: string;
  readonly projectId: number;
  /** Canonical once the destination got that far, otherwise as given. */
  readonly path: string;
  /** Set for `destination_rejected` only. */
  readonly destinationIssue?: WorktreeDestinationIssue | undefined;
  /** The containing worktree row, for `inside_checkout` when Isagi knows it. */
  readonly containingWorktreeId?: number | undefined;
  /** For `git_add_failed` and `registration_failed`: the destination exists and is non-empty. */
  readonly created?: boolean | undefined;
  readonly cause?: unknown;
}> {}

export interface DetachedWorktreeInput {
  readonly projectId: number;
  /** A full object id, 40 or 64 hex characters. */
  readonly commit: string;
  /** Caller-chosen; must be absolute. */
  readonly path: string;
}

export interface DetachedWorktree {
  readonly projectId: number;
  readonly worktreeId: number;
  readonly path: string;
  readonly head: string | null;
}

export interface DetachedWorktreeDependencies {
  readonly repository: WorkspaceRepositoryService;
  readonly git: GitService;
  /** The service's own post-create reconciliation, passed in so it stays private and single. */
  readonly reconcile: (project: ProjectRow) => Effect.Effect<unknown, unknown>;
}

/**
 * A worktree at an exact commit and an exact caller-chosen path, with no branch.
 *
 * Generic on purpose: it knows nothing about checkpoints or workflows. It never runs trust checks,
 * setup hooks or the post-create command lifecycle, and it creates or moves no branch. Git's own
 * repository hooks still run during `worktree add`, as they do for `openWorktree`.
 *
 * The body is two halves. The preflight reads rows, the filesystem and Git and writes nothing, so a
 * refused request leaves the runtime exactly as it was; in particular it does not reconcile, because
 * reconciliation writes project status and can prune rows. Only after every check passes does the
 * mutation half create the parent folder, add the worktree and reconcile to register it. A failure
 * there is reported with what is now on disk and is never cleaned up.
 */
export function createDetachedWorktree(
  dependencies: DetachedWorktreeDependencies,
  input: DetachedWorktreeInput,
): Effect.Effect<DetachedWorktree, DetachedWorktreeError | DatabaseError | GitCommandError> {
  return diagnosticPhase(
    'workspace.create_detached_worktree',
    { projectId: input.projectId, commit: input.commit, path: input.path },
    Effect.gen(function* () {
      // --- preflight: read-only ---
      const { project, listedPaths } = yield* requireRepository(dependencies, input);
      const destination = yield* checkDestination(dependencies.repository, input, listedPaths);
      yield* verifyCommit(dependencies.git, project, input.commit, destination);

      // --- mutation ---
      yield* createParent(input.projectId, destination);
      yield* addWorktree(dependencies.git, project, destination, input.commit);
      return yield* register(dependencies, project, destination);
    }),
  );
}

/**
 * Step 1. The same two probes reconciliation uses to call a project missing, so the two cannot
 * classify one repository differently: folder availability, then `git worktree list`. Only Git
 * running and refusing (`exited`) means the repository is unusable; a Git that could not run passes
 * through as `GitCommandError`. The status row is deliberately left alone: marking a project
 * missing is reconciliation's job.
 */
function requireRepository(
  dependencies: DetachedWorktreeDependencies,
  input: DetachedWorktreeInput,
) {
  return Effect.gen(function* () {
    const project = yield* dependencies.repository.findProject(input.projectId);
    const unavailable = (message: string, cause?: unknown) =>
      new DetachedWorktreeError({
        reason: 'project_unavailable',
        message,
        projectId: input.projectId,
        path: input.path,
        cause,
      });

    if (!project) {
      return yield* Effect.fail(unavailable(`Project ${input.projectId} does not exist.`));
    }
    if (project.status !== 'present') {
      return yield* Effect.fail(unavailable(`Project ${project.id} is not present.`));
    }
    if (project.kind !== 'git') {
      return yield* Effect.fail(unavailable(`Project ${project.id} is not a Git repository.`));
    }
    const availability = directoryAvailability(project.rootPath);
    if (!availability.available) {
      return yield* Effect.fail(unavailable(availability.reason));
    }

    const records = yield* listGitWorktrees(project.rootPath).pipe(
      Effect.provideService(Git, dependencies.git),
      Effect.catchIf(
        (error) => error.failure.kind === 'exited',
        (error) =>
          Effect.fail(unavailable(`Git refused the repository at ${project.rootPath}.`, error)),
      ),
    );
    // Every listed path, prunable ones included, unlike reconciliation's discovery filter: Git still
    // holds a missing-but-registered worktree's path, so a destination there is still a checkout.
    const listedPaths = records.filter((record) => !record.bare).map((record) => record.path);
    return { project, listedPaths };
  });
}

/**
 * Steps 2 and 3. The shared new-directory rule (`new-directory.ts`), with everything Git lists for
 * this project counted as a checkout too, including worktrees Isagi has not reconciled yet.
 */
function checkDestination(
  repository: WorkspaceRepositoryService,
  input: DetachedWorktreeInput,
  listedPaths: readonly string[],
) {
  return checkNewDirectory(repository, input.path, listedPaths).pipe(
    Effect.catchTag('NewDirectoryRejected', (rejected) =>
      Effect.fail(
        new DetachedWorktreeError({
          ...destinationRejectedFields(input.projectId, rejected.path, rejected.issue),
          message: rejected.message,
          containingWorktreeId: rejected.containingWorktreeId,
        }),
      ),
    ),
  );
}

/**
 * Step 4. Only Git positively answering "absent" is a missing commit: the quiet `--verify` status 1,
 * or success naming some other object. Anything else means Git could not answer and passes through
 * as `GitCommandError`, so a broken repository is never reported as a discarded commit.
 */
function verifyCommit(git: GitService, project: ProjectRow, commit: string, destination: string) {
  const notFound = new DetachedWorktreeError({
    reason: 'commit_not_found',
    message: `Commit ${commit} is not in the repository at ${project.rootPath}.`,
    projectId: project.id,
    path: destination,
  });
  return git
    .run([
      '-C',
      project.rootPath,
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${commit}^{commit}`,
    ])
    .pipe(
      Effect.catchIf(
        (error) => error.failure.kind === 'exited' && error.failure.exitCode === 1,
        () => Effect.fail(notFound),
      ),
      Effect.flatMap(({ stdout }) =>
        stdout.trim() === commit ? Effect.void : Effect.fail(notFound),
      ),
    );
}

/** Step 5. Empty parents left behind by a later failure are harmless and are not removed. */
function createParent(projectId: number, destination: string) {
  return Effect.try({
    try: () => mkdirSync(dirname(destination), { recursive: true }),
    catch: (cause) =>
      new DetachedWorktreeError({
        ...destinationRejectedFields(projectId, destination, 'inaccessible'),
        message: `Could not create the parent of ${destination}.`,
        cause,
      }),
  });
}

/** Step 6. Git refuses a non-empty or registered path itself, which covers a race with the preflight. */
function addWorktree(git: GitService, project: ProjectRow, destination: string, commit: string) {
  return git.run(['-C', project.rootPath, 'worktree', 'add', '--detach', destination, commit]).pipe(
    Effect.catchAll((cause) =>
      Effect.fail(
        new DetachedWorktreeError({
          reason: 'git_add_failed',
          message: `git worktree add failed for ${destination}: ${cause.stderr.trim() || 'no output'}`,
          projectId: project.id,
          path: destination,
          created: destinationHasContent(destination),
          cause,
        }),
      ),
    ),
  );
}

/** Step 7. The same reconciliation `openWorktree` runs after its own `worktree add`. */
function register(
  dependencies: DetachedWorktreeDependencies,
  project: ProjectRow,
  destination: string,
) {
  const failed = (message: string, cause?: unknown) =>
    new DetachedWorktreeError({
      reason: 'registration_failed',
      message,
      projectId: project.id,
      path: destination,
      created: destinationHasContent(destination),
      cause,
    });
  return Effect.gen(function* () {
    yield* dependencies
      .reconcile(project)
      .pipe(
        Effect.mapError((cause) =>
          failed(`Created ${destination}, but reconciling project ${project.id} failed.`, cause),
        ),
      );
    const row = yield* dependencies.repository
      .findProjectWorktreeByPath({ projectId: project.id, path: destination })
      .pipe(
        Effect.mapError((cause) =>
          failed(`Created ${destination}, but could not look up its worktree row.`, cause),
        ),
      );
    if (!row) {
      return yield* Effect.fail(
        failed(`Created ${destination}, but reconciliation did not register it.`),
      );
    }
    return {
      projectId: project.id,
      worktreeId: row.id,
      path: row.path,
      head: row.head,
    } satisfies DetachedWorktree;
  });
}

function destinationRejectedFields(
  projectId: number,
  path: string,
  issue: WorktreeDestinationIssue,
) {
  return {
    reason: 'destination_rejected' as const,
    projectId,
    path,
    destinationIssue: issue,
  };
}

/** What a person will find there after a failure, read from disk rather than inferred. */
function destinationHasContent(path: string) {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}
