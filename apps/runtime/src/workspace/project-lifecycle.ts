import { Effect } from 'effect';

import type {
  AddProjectOutput,
  DeleteProjectOutput,
  MoveProjectOrderOutput,
  MoveWorktreeOrderOutput,
  ProjectOrderRejectionReason,
  RelocateProjectOutput,
  WorktreeOrderRejectionReason,
} from '@isagi/contracts';

import { CommandService } from '../commands/index.js';
import { AgentSessionService } from '../environment/index.js';
import { InternalEvents } from '../platform/events/index.js';
import {
  classifyProjectRoot,
  Git,
  normalizeExistingDirectory,
  validateProjectRoot,
} from '../platform/git/index.js';
import { ProjectRepository } from '../projects/index.js';
import { PtyService } from '../pty-processes/index.js';
import { sessionPtyProcessIds, WorktreeDeleteDiagnosticsReader } from './delete-diagnostics.js';
import { ProjectOrderError, WorkspaceError, WorktreeOrderError } from './errors.js';
import { ProjectDeletionParticipant } from './project-deletion-participant.js';
import { commandCleanup, requireProject } from './project-guards.js';
import { reconciliation, reconciliationFindingsFromWorktreeResult } from './reconcile.js';
import { durableSessionDeletions, terminateSessionPtys } from './worktree-delete.js';

/**
 * A project's life in the registry: registering a path, pointing a missing Git project at its new path, deleting it,
 * and its place in the ordered project and worktree lists.
 */
export const projectLifecycle = Effect.gen(function* () {
  const repository = yield* ProjectRepository;
  const git = yield* Git;
  const commands = yield* CommandService;
  const pty = yield* PtyService;
  const agents = yield* AgentSessionService;
  const deleteDiagnostics = yield* WorktreeDeleteDiagnosticsReader;
  const internalEvents = yield* InternalEvents;
  const deletionParticipant = yield* ProjectDeletionParticipant;
  const reconcile = yield* reconciliation;
  const sessionDeletions = yield* durableSessionDeletions;

  return {
    registerProject: Effect.fn('WorkspaceService.registerProject')(function* (input: {
      readonly path: string;
    }) {
      // Canonicalize first, then look for an existing registration, and only
      // classify a path that has none. Stored kind wins: a folder project
      // someone has since run `git init` inside comes back as the same
      // folder project with the same id, and re-adding a registered Git
      // project whose Git has broken returns its id and lets reconciliation
      // report it missing, rather than refusing the add outright.
      const root = yield* normalizeExistingDirectory(input.path);
      const existing = yield* repository.findProjectByRootPath(root.rootPath);
      // Classification is the only thing that can reject a new path, and it
      // runs before the single write on this path, so a refused or
      // inconclusive answer leaves no project and no environment behind.
      // `createProject` returns the row it inserted, so there is no
      // follow-up lookup that could come back null and silently skip
      // reconciliation.
      const project =
        existing ??
        (yield* classifyProjectRoot(root).pipe(
          Effect.provideService(Git, git),
          Effect.flatMap((classified) =>
            repository.createProject({
              name: classified.name,
              rootPath: classified.rootPath,
              kind: classified.kind,
            }),
          ),
        ));

      yield* reconcile.reconcileProject(project);

      return {
        projectId: project.id,
        alreadyExisted: Boolean(existing),
      } satisfies AddProjectOutput;
    }),
    relocateProject: Effect.fn('WorkspaceService.relocateProject')(function* (input: {
      readonly path: string;
      readonly projectId: number;
    }) {
      const project = yield* requireProject(repository, input.projectId);
      // Kind is the more fundamental fact, so this precedes the missing
      // check: a folder project is told relocation is unsupported whether
      // it is present or missing. A folder project recovers at its own path
      // through reconciliation, never by being pointed somewhere else.
      if (project.kind !== 'git') {
        return yield* new WorkspaceError({
          code: 'relocation_not_supported',
          message: `Project ${input.projectId} is a folder project and cannot be relocated.`,
          projectId: input.projectId,
        });
      }
      if (project.status !== 'missing') {
        return yield* new WorkspaceError({
          code: 'project_not_missing',
          message: `Project ${input.projectId} is not missing.`,
          projectId: input.projectId,
        });
      }

      const projectRoot = yield* validateProjectRoot(input.path).pipe(
        Effect.provideService(Git, git),
      );
      const existing = yield* repository.findProjectByRootPath(projectRoot.rootPath);
      if (existing && existing.id !== input.projectId) {
        return yield* new WorkspaceError({
          code: 'project_path_already_registered',
          message: `Project path ${projectRoot.rootPath} is already registered.`,
          conflictingProjectId: existing.id,
          path: projectRoot.rootPath,
          projectId: input.projectId,
        });
      }

      const discovered = yield* reconcile.discoverWorktrees({ rootPath: projectRoot.rootPath });
      const worktrees = yield* repository.restoreProjectAtRootPath({
        discovered,
        projectId: input.projectId,
        rootPath: projectRoot.rootPath,
      });
      yield* reconcile.pruneMissingWorktrees(input.projectId, worktrees.missing);

      return {
        projectId: input.projectId,
        findings: [
          { kind: 'project_restored', projectId: input.projectId, path: projectRoot.rootPath },
          ...reconciliationFindingsFromWorktreeResult(input.projectId, worktrees),
        ],
      } satisfies RelocateProjectOutput;
    }),
    deleteProject: Effect.fn('WorkspaceService.deleteProject')(function* (projectId: number) {
      // The project is held against new agent controllers in any of its worktrees, including one
      // added during this delete, from before its worktrees are listed until the cascade commits
      // or fails; the scope removes only this delete's hold. The agents to release are read under
      // it, so an agent switched earlier is released and one switched later is refused.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* agents.holdProjectForDeletion(projectId);
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
          // The cascade below erases every agent and terminal session of these worktrees, and with
          // them the only rows that point at their live processes: stop those processes first, as
          // deleting a single worktree does, or they run on with no owner.
          const sessionPtys: number[] = [];
          for (const worktree of worktrees) {
            sessionPtys.push(...sessionPtyProcessIds(yield* deleteDiagnostics.read(worktree.id)));
          }
          // The project's workflow runs are erased in the same transaction as its row, through the
          // `ProjectDeletionParticipant` port. On the runtime's single SQLite connection, a launch
          // commits wholly before this transaction (so its run is erased here) or wholly after it
          // (so launch admission refuses it): a deleted project has no runs and can never gain
          // one. The workflows domain owns the erasure SQL (ADR 0008); this service only owns the
          // transaction boundary.
          let erasedRuns = 0;
          // Read *before* the delete: `worktrees.project_id` cascades from `projects`, so after the
          // commit there is no way to enumerate which worktrees went with it, and the
          // `project_deleted` event names exactly those ids.
          const doomedWorktreeIds = worktrees.map((worktree) => worktree.id);
          const agentSessionIds: number[] = [];
          for (const worktreeId of doomedWorktreeIds) {
            agentSessionIds.push(...(yield* deleteDiagnostics.read(worktreeId)).agentSessionIds);
          }
          yield* agents.releaseControllers(agentSessionIds);
          yield* terminateSessionPtys(pty, {
            operation: 'project_delete',
            ptyProcessIds: sessionPtys,
            projectId,
          });
          const doomed = yield* sessionDeletions.inWorktrees(new Set(doomedWorktreeIds));
          const deleted = yield* repository.deleteProject(projectId, (db) => {
            erasedRuns = deletionParticipant.eraseInTransaction(db, projectId);
          });
          if (deleted) {
            yield* sessionDeletions.publish(doomed);
            yield* internalEvents.publish({
              type: 'project_deleted',
              projectId,
              worktreeIds: doomedWorktreeIds,
            });
            yield* Effect.logInfo('Deleted project').pipe(
              Effect.annotateLogs({
                projectId,
                worktrees: doomedWorktreeIds.length,
                workflowRuns: erasedRuns,
              }),
            );
          }
          return { projectId, deleted } satisfies DeleteProjectOutput;
        }),
      );
    }),
    // No pre-read: the repository transaction is the only validation site, so
    // there is no window in which the service's view and the stored rows can
    // disagree. These methods only translate a rejection into a tagged error.
    moveProjectOrder: Effect.fn('WorkspaceService.moveProjectOrder')(function* (input: {
      readonly projectId: number;
      readonly beforeProjectId: number | null;
    }) {
      const result = yield* repository.moveProjectOrder(input);
      if (result.status !== 'moved') {
        return yield* new ProjectOrderError({
          reason: result.reason,
          message: projectOrderMessage(result.reason),
          projectId: input.projectId,
          ...(input.beforeProjectId === null ? {} : { beforeProjectId: input.beforeProjectId }),
        });
      }
      return { projectId: input.projectId } satisfies MoveProjectOrderOutput;
    }),
    moveWorktreeOrder: Effect.fn('WorkspaceService.moveWorktreeOrder')(function* (input: {
      readonly projectId: number;
      readonly worktreeId: number;
      readonly beforeWorktreeId: number | null;
    }) {
      const result = yield* repository.moveProjectWorktreeOrder(input);
      if (result.status !== 'moved') {
        return yield* new WorktreeOrderError({
          reason: result.reason,
          message: worktreeOrderMessage(result.reason),
          projectId: input.projectId,
          worktreeId: input.worktreeId,
          ...(input.beforeWorktreeId === null ? {} : { beforeWorktreeId: input.beforeWorktreeId }),
        });
      }
      return {
        projectId: input.projectId,
        worktreeId: input.worktreeId,
      } satisfies MoveWorktreeOrderOutput;
    }),
  };
});

/**
 * Diagnostic only. The line a person reads is written by the web app from the
 * stable `reason`; these exist so a log or an API response explains itself.
 */
function projectOrderMessage(reason: ProjectOrderRejectionReason) {
  switch (reason) {
    case 'project_not_found':
      return 'The project being reordered was not found.';
    case 'project_not_present':
      return 'A missing project has no position in the ordered project list.';
    case 'before_project_not_found':
      return 'The project named as the insertion anchor was not found.';
    case 'before_project_not_present':
      return 'A missing project cannot be used as an insertion anchor.';
  }
}

function worktreeOrderMessage(reason: WorktreeOrderRejectionReason) {
  switch (reason) {
    case 'project_not_found':
      return 'The project that owns the worktree was not found.';
    case 'project_not_present':
      return 'A missing project has no ordered worktree list.';
    case 'worktree_not_found':
      return 'The worktree being reordered was not found.';
    case 'worktree_project_mismatch':
      return 'That worktree belongs to a different project.';
    case 'root_worktree_fixed':
      return 'The root worktree is always first and cannot be reordered.';
    case 'before_worktree_not_found':
      return 'The worktree named as the insertion anchor was not found.';
    case 'before_worktree_project_mismatch':
      return 'The insertion anchor belongs to a different project.';
    case 'before_root_worktree_fixed':
      return 'Nothing can be placed above the root worktree.';
    case 'worktrees_not_supported':
      return 'This project maintains its own single environment, so it has no worktrees to order.';
  }
}
