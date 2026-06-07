import { existsSync, statSync } from 'node:fs';

import { Context, Data, Effect, Layer } from 'effect';

import type {
  ActiveContext,
  ActiveContextOutput,
  ActiveContextPersistenceInput,
  AddProjectOutput,
  DeleteProjectOutput,
  ReconciliationFinding,
  ReconcileWorkspaceInput,
  ReconcileWorkspaceOutput,
  RelocateProjectOutput,
  WorkspaceSnapshot,
} from '@isagi/contracts';

import {
  Git,
  type GitCommandError,
  listGitWorktrees,
  type ProjectPathValidationError,
  validateProjectRoot,
} from '../git/index.js';
import { type DatabaseError, StateFile, type StateFileError } from '../persistence/index.js';
import type { DiscoveredWorktree, ProjectRow, WorktreeRow } from './types.js';
import {
  WorkspaceRepository,
  type WorkspaceReconcileProjectWorktreesResult,
} from './workspace-repository.js';
import { buildWorkspaceSnapshot } from './workspace-snapshot.js';

export class WorkspaceError extends Data.TaggedError('WorkspaceError')<{
  readonly code:
    | 'project_not_found'
    | 'project_not_missing'
    | 'project_not_present'
    | 'project_path_already_registered'
    | 'worktree_not_found';
  readonly message: string;
  readonly conflictingProjectId?: number | undefined;
  readonly path?: string | undefined;
  readonly projectId?: number | undefined;
  readonly worktreeId?: number | undefined;
}> {}

export type WorkspaceServiceError =
  | DatabaseError
  | GitCommandError
  | ProjectPathValidationError
  | StateFileError
  | WorkspaceError;

export interface WorkspaceService {
  readonly get: Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>;
  readonly deleteProject: (
    projectId: number,
  ) => Effect.Effect<DeleteProjectOutput, WorkspaceServiceError>;
  readonly getActiveContext: Effect.Effect<ActiveContextOutput, WorkspaceServiceError>;
  readonly registerProject: (input: {
    readonly path: string;
  }) => Effect.Effect<AddProjectOutput, WorkspaceServiceError>;
  readonly relocateProject: (input: {
    readonly path: string;
    readonly projectId: number;
  }) => Effect.Effect<RelocateProjectOutput, WorkspaceServiceError>;
  readonly reconcileWorkspace: (
    input: ReconcileWorkspaceInput,
  ) => Effect.Effect<ReconcileWorkspaceOutput, WorkspaceServiceError>;
  readonly setActiveContext: (
    input: ActiveContextPersistenceInput,
  ) => Effect.Effect<ActiveContextOutput, WorkspaceServiceError>;
}

export const WorkspaceService = Context.GenericTag<WorkspaceService>('isagi/WorkspaceService');

export const WorkspaceServiceLive = Layer.effect(
  WorkspaceService,
  Effect.gen(function* () {
    const repository = yield* WorkspaceRepository;
    const stateFile = yield* StateFile;
    const git = yield* Git;

    const get = Effect.gen(function* () {
      const rows = yield* loadWorkspaceRows(repository);
      return buildWorkspaceSnapshot(rows.projects, rows.worktrees);
    });

    const getActiveContext = stateFile.read.pipe(
      Effect.map((state) => ({ activeContext: activeContextFromState(state) })),
    );

    return {
      get,
      deleteProject: (projectId) =>
        Effect.gen(function* () {
          // Do not clear persisted active context here. Active context is
          // frontend-owned restoration state; stale project/worktree references
          // are intentionally reconciled by the frontend during startup and
          // workspace refresh.
          const deleted = yield* repository.deleteProject(projectId);
          return { projectId, deleted };
        }),
      getActiveContext,
      registerProject: (input) =>
        Effect.gen(function* () {
          const projectRoot = yield* validateProjectRoot(input.path).pipe(
            Effect.provideService(Git, git),
          );
          const existing = yield* repository.findProjectByRootPath(projectRoot.rootPath);
          const alreadyExisted = Boolean(existing);
          const projectId =
            existing?.id ??
            (yield* repository.insertProject({
              name: projectRoot.name,
              rootPath: projectRoot.rootPath,
            }));
          const project = existing ?? (yield* repository.findProject(projectId));

          if (project) {
            yield* reconcileProjectWithGit(repository, project).pipe(
              Effect.provideService(Git, git),
            );
          }

          return { projectId, alreadyExisted };
        }),
      relocateProject: (input) =>
        Effect.gen(function* () {
          const project = yield* requireProject(repository, input.projectId);
          if (project.status !== 'missing') {
            return yield* Effect.fail(
              new WorkspaceError({
                code: 'project_not_missing',
                message: `Project ${input.projectId} is not missing.`,
                projectId: input.projectId,
              }),
            );
          }

          const projectRoot = yield* validateProjectRoot(input.path).pipe(
            Effect.provideService(Git, git),
          );
          const existing = yield* repository.findProjectByRootPath(projectRoot.rootPath);
          if (existing && existing.id !== input.projectId) {
            return yield* Effect.fail(
              new WorkspaceError({
                code: 'project_path_already_registered',
                message: `Project path ${projectRoot.rootPath} is already registered.`,
                conflictingProjectId: existing.id,
                path: projectRoot.rootPath,
                projectId: input.projectId,
              }),
            );
          }

          const discovered = yield* discoverWorktrees({
            ...project,
            rootPath: projectRoot.rootPath,
          }).pipe(Effect.provideService(Git, git));
          const worktrees = yield* repository.restoreProjectAtRootPath({
            discovered,
            projectId: input.projectId,
            rootPath: projectRoot.rootPath,
          });

          return {
            projectId: input.projectId,
            findings: [
              { kind: 'project_restored', projectId: input.projectId, path: projectRoot.rootPath },
              ...reconciliationFindingsFromWorktreeResult(input.projectId, worktrees),
            ],
          };
        }),
      reconcileWorkspace: (input) =>
        Effect.gen(function* () {
          const projects = input.projectId
            ? [yield* requireProject(repository, input.projectId)]
            : yield* repository.listProjects;
          const findings: ReconciliationFinding[] = [];

          for (const project of projects) {
            findings.push(
              ...(yield* reconcileProjectWithGit(repository, project).pipe(
                Effect.provideService(Git, git),
              )),
            );
          }

          return { findings };
        }),
      setActiveContext: (input) =>
        Effect.gen(function* () {
          const state = yield* stateFile.read;
          if (input.revision <= state.workspace.activeContextRevision) {
            return { activeContext: activeContextFromState(state) };
          }

          const accepted = yield* validateActiveContextPersistenceTarget(
            repository,
            input.activeContext,
          );

          const nextState = yield* stateFile.writeActiveContextIfFresh({
            activeProjectId: accepted.projectId,
            activeWorktreeId: accepted.worktreeId,
            revision: input.revision,
          });
          return { activeContext: activeContextFromState(nextState) };
        }),
    } satisfies WorkspaceService;
  }),
);

function requireProject(repository: WorkspaceRepositoryService, projectId: number) {
  return Effect.gen(function* () {
    const project = yield* repository.findProject(projectId);
    if (!project) {
      return yield* Effect.fail(
        new WorkspaceError({
          code: 'project_not_found',
          message: `Project ${projectId} was not found.`,
          projectId,
        }),
      );
    }
    return project;
  });
}

function activeContextFromState(state: {
  readonly workspace: {
    readonly activeProjectId: number | null;
    readonly activeWorktreeId: number | null;
  };
}): ActiveContext {
  if (state.workspace.activeProjectId === null) {
    return { projectId: null, worktreeId: null };
  }
  if (state.workspace.activeWorktreeId === null) {
    return { projectId: state.workspace.activeProjectId, worktreeId: null };
  }
  return {
    projectId: state.workspace.activeProjectId,
    worktreeId: state.workspace.activeWorktreeId,
  };
}

function validateActiveContextPersistenceTarget(
  repository: WorkspaceRepositoryService,
  requested: ActiveContextPersistenceInput['activeContext'],
) {
  return Effect.gen(function* () {
    if (requested.projectId === null) {
      return { projectId: null, worktreeId: null } satisfies ActiveContext;
    }

    const project = yield* repository.findProject(requested.projectId);
    if (!project) {
      return yield* Effect.fail(
        new WorkspaceError({
          code: 'project_not_found',
          message: `Project ${requested.projectId} was not found.`,
          projectId: requested.projectId,
        }),
      );
    }
    if (project.status !== 'present') {
      return yield* Effect.fail(
        new WorkspaceError({
          code: 'project_not_present',
          message: `Project ${requested.projectId} is not present.`,
          projectId: requested.projectId,
        }),
      );
    }

    const worktree = yield* repository.findWorktree(requested.worktreeId);
    if (!worktree || worktree.projectId !== requested.projectId) {
      return yield* Effect.fail(
        new WorkspaceError({
          code: 'worktree_not_found',
          message: `Worktree ${requested.worktreeId} was not found for project ${requested.projectId}.`,
          projectId: requested.projectId,
          worktreeId: requested.worktreeId,
        }),
      );
    }

    return requested;
  });
}

function reconcileProjectWithGit(repository: WorkspaceRepositoryService, project: ProjectRow) {
  return Effect.gen(function* () {
    const findings: ReconciliationFinding[] = [];

    if (!pathIsDirectory(project.rootPath)) {
      if (project.status !== 'missing') {
        findings.push({ kind: 'project_missing', projectId: project.id, path: project.rootPath });
      }
      yield* repository.setProjectStatus({
        id: project.id,
        missingReason: `Project path not found: ${project.rootPath}`,
        status: 'missing',
      });
      return findings;
    }

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
      if (project.status !== 'missing') {
        findings.push({ kind: 'project_missing', projectId: project.id, path: project.rootPath });
      }
      yield* Effect.sync(() => console.error(`[workspace] ${discovery.missingReason}`));
      yield* repository.setProjectStatus({
        id: project.id,
        missingReason: discovery.missingReason,
        status: 'missing',
      });
      return findings;
    }

    if (project.status === 'missing') {
      findings.push({ kind: 'project_restored', projectId: project.id, path: project.rootPath });
    }
    yield* repository.setProjectStatus({ id: project.id, status: 'present' });

    const worktrees = yield* repository.reconcileProjectWorktrees({
      projectId: project.id,
      discovered: discovery.discovered,
    });

    findings.push(...reconciliationFindingsFromWorktreeResult(project.id, worktrees));

    return findings;
  });
}

function reconciliationFindingsFromWorktreeResult(
  projectId: number,
  worktrees: WorkspaceReconcileProjectWorktreesResult,
): ReconciliationFinding[] {
  return [
    ...worktrees.added.map((worktree) => ({
      kind: 'worktree_added' as const,
      projectId,
      worktreeId: worktree.id,
      path: worktree.path,
    })),
    ...worktrees.missing.map((worktree) => ({
      kind: 'worktree_missing' as const,
      projectId,
      worktreeId: worktree.id,
      path: worktree.path,
    })),
  ];
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
