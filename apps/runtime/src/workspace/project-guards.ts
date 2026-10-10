import { Effect } from 'effect';

import type { ProjectRepository, ProjectRow } from '../projects/index.js';
import { directoryAvailability } from './directory-availability.js';
import { WorkspaceError } from './errors.js';

/**
 * The lookups and guards every workspace operation starts with. Each turns a missing or unusable target into the
 * `WorkspaceError` the endpoints map, so the operations themselves read as the steps they take.
 */

type Projects = ProjectRepository['Service'];

export function requireProject(repository: Projects, projectId: number) {
  return Effect.gen(function* () {
    const project = yield* repository.findProject(projectId);
    if (!project) {
      return yield* new WorkspaceError({
        code: 'project_not_found',
        message: `Project ${projectId} was not found.`,
        projectId,
      });
    }
    return project;
  });
}

export function requirePresentProject(repository: Projects, projectId: number) {
  return Effect.gen(function* () {
    const project = yield* requireProject(repository, projectId);
    if (project.status !== 'present') {
      return yield* projectNotPresent(projectId);
    }
    return project;
  });
}

export function requireProjectWorktree(
  repository: Projects,
  input: { readonly projectId: number; readonly worktreeId: number },
) {
  return Effect.gen(function* () {
    const worktree = yield* repository.findProjectWorktree(input);
    if (!worktree) {
      return yield* new WorkspaceError({
        code: 'worktree_not_found',
        message: `Worktree ${input.worktreeId} was not found for project ${input.projectId}.`,
        projectId: input.projectId,
        worktreeId: input.worktreeId,
      });
    }
    return worktree;
  });
}

export function requireProjectRootWorktree(repository: Projects, project: ProjectRow) {
  return Effect.gen(function* () {
    const rootWorktree = yield* repository.findProjectRootWorktree({
      projectId: project.id,
      rootPath: project.rootPath,
    });
    if (!rootWorktree) {
      return yield* new WorkspaceError({
        code: 'root_worktree_not_found',
        message: `Root worktree was not found for project ${project.id}.`,
        projectId: project.id,
        path: project.rootPath,
      });
    }
    return rootWorktree;
  });
}

/**
 * Worktree management is a Git-project capability. A folder project owns exactly
 * one runtime-created environment, so creating, discovering, removing or
 * reordering checkouts — and reading or writing the trust that governs their
 * setup hooks — has nothing to operate on. Refused before any Git call, presence
 * write, config read, trust write, process cleanup or row mutation.
 *
 * Deliberately separate from `requirePresentProject`, which reads persisted
 * status. The filesystem probe that can durably demote a project to `missing`
 * is `ensureProjectPathAvailable`, and this guard sits between the two so an
 * unsupported request never reaches it.
 */
export function requireGitProject(project: ProjectRow) {
  return project.kind === 'git'
    ? Effect.succeed(project)
    : Effect.fail(
        new WorkspaceError({
          code: 'worktrees_not_supported',
          message: `Project ${project.id} is a folder project and does not support worktrees.`,
          projectId: project.id,
        }),
      );
}

/** Demotes a project whose folder has gone to `missing`, then refuses the request as `project_not_present`. */
export function ensureProjectPathAvailable(repository: Projects, project: ProjectRow) {
  return Effect.gen(function* () {
    const availability = directoryAvailability(project.rootPath);
    if (availability.available) {
      return;
    }

    yield* repository.setProjectStatus({
      id: project.id,
      missingReason: availability.reason,
      status: 'missing',
    });
    return yield* projectNotPresent(project.id);
  });
}

/**
 * The one present-Git-project gate every worktree operation passes: the row exists and is present, the project is a
 * Git project, and its folder is still there.
 */
export function requireUsableGitProject(repository: Projects, projectId: number) {
  return Effect.gen(function* () {
    const project = yield* requirePresentProject(repository, projectId);
    yield* requireGitProject(project);
    yield* ensureProjectPathAvailable(repository, project);
    return project;
  });
}

export function projectNotPresent(projectId: number) {
  return new WorkspaceError({
    code: 'project_not_present',
    message: `Project ${projectId} is not present.`,
    projectId,
  });
}

/**
 * A command-domain failure while stopping a worktree's commands, as the workspace reports it. The command error stays
 * as the diagnostic cause without becoming part of the workspace API contract.
 */
export function commandCleanup<A, E>(
  effect: Effect.Effect<A, E>,
  worktreeId: number,
  projectId: number,
): Effect.Effect<A, WorkspaceError> {
  return Effect.mapError(
    effect,
    (error) =>
      new WorkspaceError({
        code: 'command_cleanup_failed',
        message: `Could not stop running commands for worktree ${worktreeId}.`,
        projectId,
        worktreeId,
        cause: error,
      }),
  );
}
