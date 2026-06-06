import { existsSync, statSync } from 'node:fs';

import { Context, Data, Effect, Layer } from 'effect';

import type { WorkspaceSnapshot } from '@isagi/contracts';

import {
  Git,
  type GitCommandError,
  listGitWorktrees,
  type ProjectPathValidationError,
  validateProjectRoot,
} from '../git/index.js';
import {
  type DatabaseError,
  StateFile,
  type StateFileError,
  stateFromActiveContext,
} from '../persistence/index.js';
import { activeContextsEqual, chooseActiveContext } from './active-context.js';
import type { DiscoveredWorktree, ProjectRow, WorktreeRow } from './types.js';
import { WorkspaceRepository } from './workspace-repository.js';
import { buildWorkspaceSnapshot } from './workspace-snapshot.js';

export class WorkspaceError extends Data.TaggedError('WorkspaceError')<{
  readonly code: 'worktree_not_found' | 'project_not_present';
  readonly message: string;
  readonly worktreeId: number;
}> {}

export type WorkspaceServiceError =
  | DatabaseError
  | GitCommandError
  | ProjectPathValidationError
  | StateFileError
  | WorkspaceError;

export interface WorkspaceService {
  readonly get: Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>;
  readonly registerProject: (input: {
    readonly path: string;
  }) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>;
  readonly setActiveContext: (input: {
    readonly worktreeId: number;
  }) => Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>;
}

export const WorkspaceService = Context.GenericTag<WorkspaceService>('isagi/WorkspaceService');

export const WorkspaceServiceLive = Layer.effect(
  WorkspaceService,
  Effect.gen(function* () {
    const repository = yield* WorkspaceRepository;
    const stateFile = yield* StateFile;
    const git = yield* Git;

    const get = Effect.gen(function* () {
      yield* reconcileWorkspaceWithGit(repository).pipe(Effect.provideService(Git, git));

      const rows = yield* loadWorkspaceRows(repository);
      const state = yield* stateFile.read;
      const requested = {
        projectId: state.workspace.activeProjectId,
        worktreeId: state.workspace.activeWorktreeId,
      };
      const activeContext = chooseActiveContext(requested, rows.projects, rows.worktrees);

      if (!activeContextsEqual(requested, activeContext)) {
        yield* stateFile.write(
          stateFromActiveContext(activeContext.projectId, activeContext.worktreeId),
        );
      }

      return buildWorkspaceSnapshot(rows.projects, rows.worktrees, activeContext);
    });

    return {
      get,
      registerProject: (input) =>
        Effect.gen(function* () {
          const projectRoot = yield* validateProjectRoot(input.path).pipe(
            Effect.provideService(Git, git),
          );
          const existing = yield* repository.findProjectByRootPath(projectRoot.rootPath);
          const projectId =
            existing?.id ??
            (yield* repository.insertProject({
              name: projectRoot.name,
              rootPath: projectRoot.rootPath,
            }));

          yield* reconcileWorkspaceWithGit(repository).pipe(Effect.provideService(Git, git));
          const rows = yield* loadWorkspaceRows(repository);
          const project = rows.projects.find((candidate) => candidate.id === projectId);
          const worktree =
            rows.worktrees.find(
              (candidate) => candidate.projectId === projectId && candidate.isRoot === 1,
            ) ?? rows.worktrees.find((candidate) => candidate.projectId === projectId);

          if (project && worktree) {
            yield* stateFile.write(stateFromActiveContext(project.id, worktree.id));
          }

          return yield* get;
        }),
      setActiveContext: (input) =>
        Effect.gen(function* () {
          yield* reconcileWorkspaceWithGit(repository).pipe(Effect.provideService(Git, git));
          const worktree = yield* repository.findWorktree(input.worktreeId);

          if (!worktree) {
            return yield* Effect.fail(
              new WorkspaceError({
                code: 'worktree_not_found',
                message: `Worktree ${input.worktreeId} was not found.`,
                worktreeId: input.worktreeId,
              }),
            );
          }
          const projects = yield* repository.listProjects;
          const project = projects.find((candidate) => candidate.id === worktree.projectId);
          if (!project || project.status !== 'present') {
            return yield* Effect.fail(
              new WorkspaceError({
                code: 'project_not_present',
                message: `Worktree ${input.worktreeId} belongs to a project that is not present.`,
                worktreeId: input.worktreeId,
              }),
            );
          }

          yield* stateFile.write(stateFromActiveContext(worktree.projectId, worktree.id));
          return yield* get;
        }),
    } satisfies WorkspaceService;
  }),
);

function reconcileWorkspaceWithGit(repository: WorkspaceRepositoryService) {
  return Effect.gen(function* () {
    const projects = yield* repository.listProjects;

    for (const project of projects) {
      if (!pathIsDirectory(project.rootPath)) {
        yield* repository.setProjectStatus({
          id: project.id,
          missingReason: `Project path not found: ${project.rootPath}`,
          status: 'missing',
        });
        continue;
      }

      yield* repository.setProjectStatus({ id: project.id, status: 'present' });

      const discovery = yield* discoverWorktrees(project).pipe(
        Effect.match({
          onFailure: (error) => ({
            status: 'failed' as const,
            missingReason: describeWorktreeDiscoveryFailure(project.rootPath, error),
          }),
          onSuccess: (discovered) => ({ status: 'succeeded' as const, discovered }),
        }),
      );
      if (discovery.status === 'failed') {
        yield* Effect.sync(() => console.error(`[workspace] ${discovery.missingReason}`));
        yield* repository.setProjectStatus({
          id: project.id,
          missingReason: discovery.missingReason,
          status: 'missing',
        });
        continue;
      }
      yield* repository.reconcileProjectWorktrees({
        projectId: project.id,
        discovered: discovery.discovered,
      });
    }
  });
}

function discoverWorktrees(project: ProjectRow) {
  return listGitWorktrees(project.rootPath).pipe(
    Effect.map((records): readonly DiscoveredWorktree[] =>
      records
        .filter((record) => !record.bare && !record.prunable && pathIsDirectory(record.path))
        .map((record) => ({
          path: record.path,
          branch: record.branch,
          head: record.head,
          isRoot: record.path === project.rootPath,
        })),
    ),
  );
}

function loadWorkspaceRows(repository: WorkspaceRepositoryService) {
  return Effect.gen(function* () {
    const projects = yield* repository.listProjects;
    const worktrees = yield* repository.listWorktrees;
    return { projects, worktrees } satisfies {
      projects: ProjectRow[];
      worktrees: WorktreeRow[];
    };
  });
}

function describeWorktreeDiscoveryFailure(rootPath: string, error: GitCommandError) {
  const command = ['git', ...error.args].join(' ');
  const cwd = error.cwd ?? rootPath;
  const stderr = error.stderr.trim();
  const detail = stderr ? ` stderr: ${stderr}` : '';
  return `Could not read Git worktrees for ${rootPath} using ${command} in ${cwd}.${detail}`;
}

function pathIsDirectory(path: string) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

type WorkspaceRepositoryService = Context.Tag.Service<typeof WorkspaceRepository>;
