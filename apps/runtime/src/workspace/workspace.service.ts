import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Context, Data, Effect, Layer } from 'effect';

import type {
  ActiveContext,
  ActiveContextOutput,
  ActiveContextPersistenceInput,
  AddProjectOutput,
  DeleteWorktreeInput,
  DeleteWorktreeOutput,
  DeleteProjectOutput,
  DeleteWorktreePreflightOutput,
  ListProjectBranchesOutput,
  OpenWorktreeInput,
  OpenWorktreeOutput,
  ReconciliationFinding,
  WorktreeSetupPreflightOutput,
  WorktreeSetupTrustInput,
  WorktreeSetupTrustOutput,
  ReconcileWorkspaceInput,
  ReconcileWorkspaceOutput,
  RelocateProjectOutput,
  WorkspaceSnapshot,
  WorktreeBaseRef,
  DurableSessionIdentity,
  DurableSessionInventory,
} from '@isagi/contracts';

import { CommandService } from '../commands/index.js';
import { diagnosticPhase, logDiagnosticEvent } from '../diagnostics/phase.js';
import {
  branchPathHash,
  Git,
  type GitCommandError,
  listGitWorktrees,
  listLocalBranches,
  type ProjectPathValidationError,
  validateProjectRoot,
} from '../git/index.js';
import {
  DataDirectory,
  type DatabaseError,
  StateFile,
  type StateFileError,
} from '../persistence/index.js';
import { ProjectConfigError } from '../project-config/project-config.service.js';
import {
  activePtyProcessIds,
  PtyService,
  terminatePtyProcessIds,
  type PtyServiceShape,
} from '../pty-processes/index.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import { SurfaceRepository } from '../surfaces/index.js';
import {
  runPostCreateSetup,
  WorktreeSetupError,
  WorktreeSetupRepository,
  WorktreeSetupRunError,
  WorktreeSetupService,
} from '../worktree-setup/index.js';
import type { DiscoveredWorktree, ProjectRow, WorktreeRow } from './types.js';
import {
  WorkspaceRepository,
  type WorktreeDeleteDiagnostics,
  type WorkspaceReconcileProjectWorktreesResult,
} from './workspace.repository.js';
import { buildWorkspaceSnapshot } from './workspace.snapshot.js';

export class WorkspaceError extends Data.TaggedError('WorkspaceError')<{
  readonly code:
    | 'project_not_found'
    | 'project_not_missing'
    | 'project_not_present'
    | 'project_path_already_registered'
    | 'branch_not_found'
    | 'new_branch_requires_base'
    | 'invalid_branch_name'
    | 'base_ref_not_found'
    | 'checkout_path_exists'
    | 'checkout_path_registered'
    | 'checkout_parent_unavailable'
    | 'worktree_not_found'
    | 'root_worktree_not_deletable'
    | 'dirty_checkout_requires_force'
    | 'root_worktree_not_found'
    | 'command_cleanup_failed'
    | 'pty_teardown_failed'
    | 'setup_config_invalid'
    | 'setup_trust_required'
    | 'setup_trust_mismatch';
  readonly message: string;
  readonly branch?: string | undefined;
  readonly conflictingProjectId?: number | undefined;
  readonly path?: string | undefined;
  readonly projectId?: number | undefined;
  readonly worktreeId?: number | undefined;
  readonly cause?: unknown;
}> {}

export type WorkspaceServiceError =
  | DatabaseError
  | GitCommandError
  | ProjectConfigError
  | ProjectPathValidationError
  | StateFileError
  | WorktreeSetupError
  | WorktreeSetupRunError
  | WorkspaceError;

export interface WorkspaceService {
  readonly get: Effect.Effect<WorkspaceSnapshot, WorkspaceServiceError>;
  readonly durableSessions: Effect.Effect<DurableSessionInventory, WorkspaceServiceError>;
  readonly deleteProject: (
    projectId: number,
  ) => Effect.Effect<DeleteProjectOutput, WorkspaceServiceError>;
  readonly getActiveContext: Effect.Effect<ActiveContextOutput, WorkspaceServiceError>;
  readonly listProjectBranches: (input: {
    readonly projectId: number;
  }) => Effect.Effect<ListProjectBranchesOutput, WorkspaceServiceError>;
  readonly preflightWorktreeSetup: (input: {
    readonly projectId: number;
  }) => Effect.Effect<WorktreeSetupPreflightOutput, WorkspaceServiceError>;
  readonly trustWorktreeSetup: (input: {
    readonly projectId: number;
    readonly request: WorktreeSetupTrustInput;
  }) => Effect.Effect<WorktreeSetupTrustOutput, WorkspaceServiceError>;
  readonly openWorktree: (input: {
    readonly projectId: number;
    readonly request: OpenWorktreeInput;
  }) => Effect.Effect<OpenWorktreeOutput, WorkspaceServiceError>;
  readonly preflightDeleteWorktree: (input: {
    readonly projectId: number;
    readonly worktreeId: number;
  }) => Effect.Effect<DeleteWorktreePreflightOutput, WorkspaceServiceError>;
  readonly deleteWorktree: (input: {
    readonly projectId: number;
    readonly worktreeId: number;
    readonly request: DeleteWorktreeInput;
  }) => Effect.Effect<DeleteWorktreeOutput, WorkspaceServiceError>;
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
    const dataDirectory = yield* DataDirectory;
    const worktreeSetup = yield* WorktreeSetupService;
    const worktreeSetupRepository = yield* WorktreeSetupRepository;
    const surfaceRepository = yield* SurfaceRepository;
    const commands = yield* CommandService;
    const pty = yield* PtyService;
    const internalEvents = yield* InternalRuntimeEventBus;

    const get = Effect.gen(function* () {
      const rows = yield* loadWorkspaceRows(repository);
      const surfaces = yield* surfaceRepository.listWorkspaceSurfaceMetadata;
      const environmentFocus = yield* surfaceRepository.listEnvironmentFocusStates;
      return buildWorkspaceSnapshot(rows.projects, rows.worktrees, surfaces, environmentFocus);
    });

    const getActiveContext = stateFile.read.pipe(
      Effect.map((state) => ({ activeContext: activeContextFromState(state) })),
    );

    const durableSessions = repository.listDurableSessions;

    /**
     * The durable identities a worktree owns, read before its row is deleted. The DB
     * cascade removes those rows silently, so any client that is not the one issuing the
     * delete would otherwise never learn its cached terminals are gone.
     */
    const durableSessionsInWorktrees = (worktreeIds: ReadonlySet<number>) =>
      repository.listDurableSessions.pipe(
        Effect.map((inventory) =>
          inventory.sessions.filter((session) => worktreeIds.has(session.worktreeId)),
        ),
      );

    const publishDurableSessionDeletions = (
      identities: readonly DurableSessionIdentity[],
    ): Effect.Effect<void> =>
      Effect.forEach(
        identities,
        (identity) => internalEvents.publish({ type: 'durable_session_deleted', identity }),
        { discard: true },
      );

    return {
      get,
      durableSessions,
      deleteProject: (projectId) =>
        Effect.gen(function* () {
          // Do not clear persisted active context here. Active context is
          // frontend-owned restoration state; stale project/worktree references
          // are intentionally reconciled by the frontend during startup and
          // workspace refresh.
          const worktrees = (yield* repository.listWorktrees).filter(
            (worktree) => worktree.projectId === projectId,
          );
          for (const worktree of worktrees) {
            yield* commandCleanup(
              commands.cleanupBeforeWorktreeDelete({ worktreeId: worktree.id }),
              worktree.id,
              projectId,
            );
          }
          const doomed = yield* durableSessionsInWorktrees(
            new Set(worktrees.map((worktree) => worktree.id)),
          );
          const deleted = yield* repository.deleteProject(projectId);
          if (deleted) yield* publishDurableSessionDeletions(doomed);
          return { projectId, deleted };
        }),
      getActiveContext,
      listProjectBranches: (input) =>
        Effect.gen(function* () {
          const project = yield* requirePresentProject(repository, input.projectId);
          yield* ensureProjectPathAvailable(repository, project);
          const branches = yield* listLocalBranches(project.rootPath).pipe(
            Effect.provideService(Git, git),
          );
          const worktrees = yield* repository.listWorktrees;
          const worktreeIdByBranch = new Map(
            worktrees
              .filter((worktree) => worktree.projectId === project.id && worktree.branch)
              .map((worktree) => [worktree.branch as string, worktree.id] as const),
          );

          return {
            branches: branches.map((branch) => ({
              name: branch,
              worktreeId: worktreeIdByBranch.get(branch) ?? null,
            })),
          } satisfies ListProjectBranchesOutput;
        }),
      preflightWorktreeSetup: (input) =>
        Effect.gen(function* () {
          const project = yield* requirePresentProject(repository, input.projectId);
          yield* ensureProjectPathAvailable(repository, project);
          return yield* worktreeSetup.preflight(project);
        }),
      trustWorktreeSetup: (input) =>
        Effect.gen(function* () {
          const project = yield* requirePresentProject(repository, input.projectId);
          yield* ensureProjectPathAvailable(repository, project);
          return yield* worktreeSetup.updateTrust({ project, request: input.request });
        }),
      openWorktree: (input) =>
        diagnosticPhase(
          'workspace.open_worktree',
          { projectId: input.projectId, branch: input.request.branch.trim() },
          Effect.gen(function* () {
            const project = yield* requirePresentProject(repository, input.projectId);
            const branch = input.request.branch.trim();
            const context = {
              projectId: project.id,
              rootPath: project.rootPath,
              branch,
            } as const;
            if (!branch) {
              return yield* Effect.fail(
                new WorkspaceError({
                  code: 'branch_not_found',
                  message: 'A branch name is required to open a worktree.',
                  projectId: input.projectId,
                }),
              );
            }

            yield* ensureProjectPathAvailable(repository, project);
            yield* validateBranchName(git, project, branch);
            yield* reconcileProjectWithGit(repository, commands, project).pipe(
              Effect.provideService(Git, git),
            );
            const existing = yield* repository.findProjectWorktreeByBranch({
              projectId: project.id,
              branch,
            });
            if (existing) {
              return {
                projectId: project.id,
                worktreeId: existing.id,
                branch,
                status: 'opened_existing',
                setup: { status: 'not_run', reason: 'existing_worktree' },
              } satisfies OpenWorktreeOutput;
            }

            const branches = yield* listLocalBranches(project.rootPath).pipe(
              Effect.provideService(Git, git),
            );
            const branchExists = branches.includes(branch);
            let baseRef: string | null = null;
            if (!branchExists) {
              const base = input.request.base;
              if (!base) {
                return yield* Effect.fail(
                  new WorkspaceError({
                    branch,
                    code: 'new_branch_requires_base',
                    message: `Branch ${branch} does not exist. Choose what to create it from.`,
                    projectId: project.id,
                  }),
                );
              }
              baseRef = yield* validateBaseRef(repository, git, project, base);
            }

            const setupPlan = yield* worktreeSetup.validateTrustForOpen(project);

            const checkoutPath = checkoutPathForBranch(
              dataDirectory.paths.worktreesPath,
              project.id,
              branch,
            );
            const checkoutContext = { ...context, checkoutPath };
            yield* ensureCheckoutPathAvailable(git, project, branch, checkoutPath);
            yield* prepareCheckoutParent(project, branch, checkoutPath);

            if (branchExists) {
              yield* diagnosticPhase(
                'workspace.open_worktree.git_add_existing_branch',
                checkoutContext,
                git.run(['-C', project.rootPath, 'worktree', 'add', checkoutPath, branch]),
              );
            } else {
              if (!baseRef) {
                return yield* Effect.die('Base ref was validated but not available.');
              }
              yield* diagnosticPhase(
                'workspace.open_worktree.git_add_new_branch',
                { ...checkoutContext, baseRef },
                git.run([
                  '-C',
                  project.rootPath,
                  'worktree',
                  'add',
                  '-b',
                  branch,
                  checkoutPath,
                  baseRef,
                ]),
              );
            }
            yield* diagnosticPhase(
              'workspace.open_worktree.reconcile_after_git_add',
              checkoutContext,
              reconcileProjectWithGit(repository, commands, project).pipe(
                Effect.provideService(Git, git),
              ),
            );
            const created = yield* repository.findProjectWorktreeByBranch({
              projectId: project.id,
              branch,
            });
            if (!created) {
              return yield* Effect.fail(
                new WorkspaceError({
                  branch,
                  code: 'worktree_not_found',
                  message: `Git created branch ${branch}, but Isagi could not find the new worktree after reconciliation.`,
                  projectId: project.id,
                }),
              );
            }

            if (setupPlan.status === 'disabled') {
              yield* commands.runPostCreateLifecycle({ worktreeId: created.id });
              return {
                projectId: project.id,
                worktreeId: created.id,
                branch,
                status: 'created',
                setup: { status: 'skipped', reason: 'hooks_disabled' },
              } satisfies OpenWorktreeOutput;
            }

            if (setupPlan.status === 'not_configured') {
              yield* commands.runPostCreateLifecycle({ worktreeId: created.id });
              return {
                projectId: project.id,
                worktreeId: created.id,
                branch,
                status: 'created',
                setup: { status: 'skipped', reason: 'not_configured' },
              } satisfies OpenWorktreeOutput;
            }

            const setup = yield* diagnosticPhase(
              'workspace.open_worktree.post_create_setup',
              { ...checkoutContext, worktreeId: created.id, setupStatus: setupPlan.status },
              runPostCreateSetup({
                config: setupPlan.config,
                hash: setupPlan.hash,
                projectRootPath: project.rootPath,
                worktreeId: created.id,
                worktreePath: created.path,
              }).pipe(Effect.provideService(WorktreeSetupRepository, worktreeSetupRepository)),
            );

            if (setup.status === 'failed') {
              return {
                projectId: project.id,
                worktreeId: created.id,
                branch,
                status: 'created_setup_failed',
                setup,
              } satisfies OpenWorktreeOutput;
            }

            yield* commands.runPostCreateLifecycle({ worktreeId: created.id });

            return {
              projectId: project.id,
              worktreeId: created.id,
              branch,
              status: 'created',
              setup,
            } satisfies OpenWorktreeOutput;
          }),
        ),
      preflightDeleteWorktree: (input) =>
        Effect.gen(function* () {
          const project = yield* requirePresentProject(repository, input.projectId);
          yield* ensureProjectPathAvailable(repository, project);
          const worktree = yield* requireProjectWorktree(repository, {
            projectId: project.id,
            worktreeId: input.worktreeId,
          });
          const dirty = yield* checkoutIsDirty(git, worktree.path);
          return {
            projectId: project.id,
            worktreeId: worktree.id,
            path: worktree.path,
            branch: worktree.branch,
            isRoot: isRootWorktree(project, worktree),
            dirty,
          } satisfies DeleteWorktreePreflightOutput;
        }),
      deleteWorktree: (input) =>
        diagnosticPhase(
          'workspace.delete_worktree',
          {
            projectId: input.projectId,
            worktreeId: input.worktreeId,
            checkoutRemovalMode: input.request.checkoutRemovalMode,
            branchRemovalMode: input.request.branchRemovalMode,
          },
          Effect.gen(function* () {
            const project = yield* requirePresentProject(repository, input.projectId);
            yield* ensureProjectPathAvailable(repository, project);
            const worktree = yield* requireProjectWorktree(repository, {
              projectId: project.id,
              worktreeId: input.worktreeId,
            });
            const rootWorktree = yield* requireProjectRootWorktree(repository, project);
            const context = {
              projectId: project.id,
              worktreeId: worktree.id,
              path: worktree.path,
              branch: worktree.branch,
              checkoutRemovalMode: input.request.checkoutRemovalMode,
              branchRemovalMode: input.request.branchRemovalMode,
            } as const;

            if (isRootWorktree(project, worktree)) {
              return yield* Effect.fail(
                new WorkspaceError({
                  code: 'root_worktree_not_deletable',
                  message: `Root worktree ${worktree.id} cannot be deleted.`,
                  projectId: project.id,
                  worktreeId: worktree.id,
                  path: worktree.path,
                }),
              );
            }

            const dirty = yield* checkoutIsDirty(git, worktree.path);
            if (dirty && input.request.checkoutRemovalMode === 'normal') {
              return yield* Effect.fail(
                new WorkspaceError({
                  code: 'dirty_checkout_requires_force',
                  message: `Worktree ${worktree.id} has uncommitted or untracked changes.`,
                  projectId: project.id,
                  worktreeId: worktree.id,
                  path: worktree.path,
                }),
              );
            }

            // Destructive sequencing is deliberate: the worktree was already
            // validated above; stop command processes, terminate active session
            // processes, remove the Git worktree, delete the DB row so dependent
            // state cascades, then optionally safe-delete the branch.
            // `checkoutRemovalMode: "force"` does not force branch deletion.
            const diagnostics = yield* repository.readWorktreeDeleteDiagnostics(worktree.id);
            const doomedSessions = yield* durableSessionsInWorktrees(new Set([worktree.id]));
            logDiagnosticEvent('workspace.delete_worktree.delete_diagnostics', {
              ...context,
              agentSessionCount: diagnostics.agentSessionCount,
              agentSessionActivePtyProcessIds: diagnostics.agentSessionActivePtyProcessIds,
              commandRunCount: diagnostics.commandRunCount,
              commandRunPtyProcessIds: diagnostics.commandRunPtyProcessIds,
              commandStateCount: diagnostics.commandStateCount,
              commandStateActivePtyProcessIds: diagnostics.commandStateActivePtyProcessIds,
              paneCount: diagnostics.paneCount,
              surfaceCount: diagnostics.surfaceCount,
              terminalSessionCount: diagnostics.terminalSessionCount,
              terminalSessionActivePtyProcessIds: diagnostics.terminalSessionActivePtyProcessIds,
            });
            yield* diagnosticPhase(
              'workspace.delete_worktree.command_cleanup',
              context,
              commandCleanup(
                commands.cleanupBeforeWorktreeDelete({ worktreeId: worktree.id }),
                worktree.id,
                project.id,
              ),
            );
            yield* diagnosticPhase(
              'workspace.delete_worktree.pty_teardown',
              context,
              terminateWorktreeSessionPtys(pty, diagnostics, {
                projectId: project.id,
                worktreeId: worktree.id,
              }),
            );
            yield* diagnosticPhase(
              'workspace.delete_worktree.git_remove',
              context,
              git.run(
                input.request.checkoutRemovalMode === 'force'
                  ? ['-C', project.rootPath, 'worktree', 'remove', '--force', worktree.path]
                  : ['-C', project.rootPath, 'worktree', 'remove', worktree.path],
              ),
            );
            yield* diagnosticPhase(
              'workspace.delete_worktree.db_delete',
              context,
              repository.deleteWorktree(worktree.id),
            );
            // Announced only after the cascade commits: every connected client — not just
            // the one that asked — drops the terminals these identities backed.
            yield* publishDurableSessionDeletions(doomedSessions);
            const branchRemoval = yield* diagnosticPhase(
              'workspace.delete_worktree.branch_delete',
              context,
              deleteBranchIfRequested(git, project, worktree, input.request),
            );

            return {
              projectId: project.id,
              deletedWorktreeId: worktree.id,
              selectedWorktreeId: rootWorktree.id,
              branchRemoval,
            } satisfies DeleteWorktreeOutput;
          }),
        ),
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
            yield* reconcileProjectWithGit(repository, commands, project).pipe(
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
          yield* pruneMissingWorktrees(repository, commands, input.projectId, worktrees.missing);

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
              ...(yield* reconcileProjectWithGit(repository, commands, project).pipe(
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
          const previousWorktreeId = state.workspace.activeWorktreeId;
          const nextWorktreeId = nextState.workspace.activeWorktreeId;
          if (
            nextState.workspace.activeContextRevision === input.revision &&
            previousWorktreeId !== nextWorktreeId
          ) {
            yield* internalEvents.publish({
              type: 'worktree_activation_change',
              previousWorktreeId,
              nextWorktreeId,
              cause: 'active_context_changed',
            });
          }
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

function requireProjectWorktree(
  repository: WorkspaceRepositoryService,
  input: { readonly projectId: number; readonly worktreeId: number },
) {
  return Effect.gen(function* () {
    const worktree = yield* repository.findProjectWorktree(input);
    if (!worktree) {
      return yield* Effect.fail(
        new WorkspaceError({
          code: 'worktree_not_found',
          message: `Worktree ${input.worktreeId} was not found for project ${input.projectId}.`,
          projectId: input.projectId,
          worktreeId: input.worktreeId,
        }),
      );
    }
    return worktree;
  });
}

function requireProjectRootWorktree(repository: WorkspaceRepositoryService, project: ProjectRow) {
  return Effect.gen(function* () {
    const rootWorktree = yield* repository.findProjectRootWorktree({
      projectId: project.id,
      rootPath: project.rootPath,
    });
    if (!rootWorktree) {
      return yield* Effect.fail(
        new WorkspaceError({
          code: 'root_worktree_not_found',
          message: `Root worktree was not found for project ${project.id}.`,
          projectId: project.id,
          path: project.rootPath,
        }),
      );
    }
    return rootWorktree;
  });
}

function requirePresentProject(repository: WorkspaceRepositoryService, projectId: number) {
  return Effect.gen(function* () {
    const project = yield* requireProject(repository, projectId);
    if (project.status !== 'present') {
      return yield* Effect.fail(projectNotPresent(projectId));
    }
    return project;
  });
}

function isRootWorktree(project: ProjectRow, worktree: WorktreeRow) {
  return worktree.path === project.rootPath;
}

function checkoutIsDirty(git: GitServiceShape, checkoutPath: string) {
  return git
    .run(['-C', checkoutPath, 'status', '--porcelain'])
    .pipe(Effect.map(({ stdout }) => stdout.trim().length > 0));
}

function deleteBranchIfRequested(
  git: GitServiceShape,
  project: ProjectRow,
  worktree: WorktreeRow,
  request: DeleteWorktreeInput,
): Effect.Effect<DeleteWorktreeOutput['branchRemoval'], never, never> {
  if (request.branchRemovalMode === 'preserve') {
    return Effect.succeed({ status: 'not_requested' });
  }
  if (!worktree.branch) {
    return Effect.succeed({ status: 'not_applicable' });
  }

  return git.run(['-C', project.rootPath, 'branch', '-d', worktree.branch]).pipe(
    Effect.as({ status: 'deleted' as const, branch: worktree.branch }),
    Effect.catchAll((error) =>
      Effect.succeed({
        status: 'failed' as const,
        branch: worktree.branch as string,
        diagnostic: gitBranchDeleteDiagnostic(error),
      }),
    ),
  );
}

function gitBranchDeleteDiagnostic(error: GitCommandError) {
  const stderr = error.stderr.trim();
  if (stderr) {
    return stderr;
  }
  return `git ${error.args.join(' ')} failed`;
}

function ensureProjectPathAvailable(repository: WorkspaceRepositoryService, project: ProjectRow) {
  return Effect.gen(function* () {
    if (pathIsDirectory(project.rootPath)) {
      return;
    }

    yield* repository.setProjectStatus({
      id: project.id,
      missingReason: `Project path not found: ${project.rootPath}`,
      status: 'missing',
    });
    return yield* Effect.fail(projectNotPresent(project.id));
  });
}

function projectNotPresent(projectId: number) {
  return new WorkspaceError({
    code: 'project_not_present',
    message: `Project ${projectId} is not present.`,
    projectId,
  });
}

function commandCleanup<A>(
  effect: Effect.Effect<A, unknown>,
  worktreeId: number,
  projectId: number,
): Effect.Effect<A, WorkspaceError> {
  return effect.pipe(
    Effect.mapError(
      (error) =>
        new WorkspaceError({
          code: 'command_cleanup_failed',
          message: `Could not stop running commands for worktree ${worktreeId}.`,
          projectId,
          worktreeId,
          // Keep the command-domain error as diagnostic cause without making it
          // part of the workspace API contract.
          cause: error,
        }),
    ),
  );
}

function terminateWorktreeSessionPtys(
  pty: PtyServiceShape,
  diagnostics: WorktreeDeleteDiagnostics,
  context: {
    readonly projectId: number;
    readonly worktreeId: number;
  },
) {
  return terminatePtyProcessIds(pty, {
    failurePolicy: 'required',
    gracefulTimeoutMs: 1_000,
    operation: 'worktree_delete',
    ptyProcessIds: activePtyProcessIds({
      agentSessionActivePtyProcessIds: diagnostics.agentSessionActivePtyProcessIds,
      terminalSessionActivePtyProcessIds: diagnostics.terminalSessionActivePtyProcessIds,
    }),
  }).pipe(
    Effect.mapError(
      (error) =>
        new WorkspaceError({
          code: 'pty_teardown_failed',
          message: `Could not stop active sessions for worktree ${context.worktreeId}.`,
          projectId: context.projectId,
          worktreeId: context.worktreeId,
          cause: error,
        }),
    ),
  );
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

function reconcileProjectWithGit(
  repository: WorkspaceRepositoryService,
  commands: import('../commands/index.js').CommandServiceShape,
  project: ProjectRow,
) {
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
    yield* pruneMissingWorktrees(repository, commands, project.id, worktrees.missing);

    findings.push(...reconciliationFindingsFromWorktreeResult(project.id, worktrees));

    return findings;
  });
}

function pruneMissingWorktrees(
  repository: WorkspaceRepositoryService,
  commands: import('../commands/index.js').CommandServiceShape,
  projectId: number,
  worktrees: readonly Pick<WorktreeRow, 'id'>[],
) {
  return Effect.gen(function* () {
    for (const worktree of worktrees) {
      yield* commandCleanup(
        commands.cleanupBeforeWorktreePrune({ worktreeId: worktree.id }),
        worktree.id,
        projectId,
      );
      const current = yield* repository.findWorktree(worktree.id);
      if (current) {
        yield* repository.deleteWorktree(worktree.id);
      }
    }
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
      branch: worktree.branch,
    })),
    ...worktrees.missing.map((worktree) => ({
      kind: 'worktree_missing' as const,
      projectId,
      worktreeId: worktree.id,
      path: worktree.path,
      branch: worktree.branch,
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

function validateBranchName(git: GitServiceShape, project: ProjectRow, branch: string) {
  return git.run(['-C', project.rootPath, 'check-ref-format', '--branch', branch]).pipe(
    Effect.asVoid,
    Effect.catchAll(() =>
      Effect.fail(
        new WorkspaceError({
          branch,
          code: 'invalid_branch_name',
          message: `Branch name "${branch}" is not valid for Git.`,
          projectId: project.id,
        }),
      ),
    ),
  );
}

function validateBaseRef(
  repository: WorkspaceRepositoryService,
  git: GitServiceShape,
  project: ProjectRow,
  base: WorktreeBaseRef,
) {
  if (base.kind === 'branch') {
    return listLocalBranches(project.rootPath).pipe(
      Effect.provideService(Git, git),
      Effect.flatMap((branches) =>
        branches.includes(base.ref)
          ? Effect.succeed(base.ref)
          : Effect.fail(
              new WorkspaceError({
                branch: base.ref,
                code: 'base_ref_not_found',
                message: `Base branch "${base.ref}" was not found in project ${project.id}.`,
                projectId: project.id,
              }),
            ),
      ),
    );
  }

  return Effect.gen(function* () {
    const worktree = yield* repository.findWorktree(base.worktreeId);
    if (!worktree || worktree.projectId !== project.id || worktree.branch || !worktree.head) {
      return yield* Effect.fail(
        new WorkspaceError({
          code: 'base_ref_not_found',
          message: `Detached worktree ${base.worktreeId} was not found for project ${project.id}.`,
          projectId: project.id,
          worktreeId: base.worktreeId,
        }),
      );
    }

    const discovered = yield* listGitWorktrees(project.rootPath).pipe(
      Effect.provideService(Git, git),
    );
    const stillDetached = discovered.some(
      (candidate) =>
        candidate.path === worktree.path &&
        candidate.head === worktree.head &&
        candidate.branch === null &&
        !candidate.bare &&
        !candidate.prunable,
    );
    if (!stillDetached) {
      return yield* Effect.fail(
        new WorkspaceError({
          code: 'base_ref_not_found',
          message: `Detached worktree ${base.worktreeId} is no longer available as a base for project ${project.id}.`,
          projectId: project.id,
          worktreeId: base.worktreeId,
        }),
      );
    }

    return worktree.head;
  });
}

function checkoutPathForBranch(worktreesPath: string, projectId: number, branch: string) {
  return join(worktreesPath, String(projectId), branchPathHash(branch));
}

function ensureCheckoutPathAvailable(
  git: GitServiceShape,
  project: ProjectRow,
  branch: string,
  checkoutPath: string,
) {
  return Effect.gen(function* () {
    if (pathExists(checkoutPath)) {
      return yield* Effect.fail(
        new WorkspaceError({
          branch,
          code: 'checkout_path_exists',
          message: `Worktree checkout path already exists: ${checkoutPath}`,
          path: checkoutPath,
          projectId: project.id,
        }),
      );
    }

    const registered = yield* listGitWorktrees(project.rootPath).pipe(
      Effect.provideService(Git, git),
    );
    if (registered.some((worktree) => worktree.path === checkoutPath)) {
      return yield* Effect.fail(
        new WorkspaceError({
          branch,
          code: 'checkout_path_registered',
          message: `Worktree checkout path is still registered by Git: ${checkoutPath}. Run git worktree prune or remove the stale worktree, then try again.`,
          path: checkoutPath,
          projectId: project.id,
        }),
      );
    }
  });
}

function prepareCheckoutParent(project: ProjectRow, branch: string, checkoutPath: string) {
  return Effect.try({
    try: () => mkdirSync(dirname(checkoutPath), { recursive: true }),
    catch: () =>
      new WorkspaceError({
        branch,
        code: 'checkout_parent_unavailable',
        message: `Could not prepare the worktree checkout directory for project ${project.id}.`,
        path: checkoutPath,
        projectId: project.id,
      }),
  });
}

function pathIsDirectory(path: string) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pathExists(path: string) {
  try {
    return existsSync(path);
  } catch {
    return true;
  }
}

type WorkspaceRepositoryService = Context.Tag.Service<typeof WorkspaceRepository>;
type GitServiceShape = Context.Tag.Service<typeof Git>;
