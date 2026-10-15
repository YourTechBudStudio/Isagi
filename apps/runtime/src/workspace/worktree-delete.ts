import { Effect } from 'effect';

import type {
  DeleteWorktreeInput,
  DeleteWorktreeOutput,
  DeleteWorktreePreflightOutput,
  DurableSessionIdentity,
} from '@isagi/contracts';

import { CommandService } from '../commands/index.js';
import { AgentSessionService, SurfaceService } from '../environment/index.js';
import { diagnosticPhase } from '../platform/diagnostics/index.js';
import { InternalEvents } from '../platform/events/index.js';
import { Git, type GitCommandError } from '../platform/git/index.js';
import { ProjectRepository, type ProjectRow, type WorktreeRow } from '../projects/index.js';
import { PtyService } from '../pty-processes/index.js';
import { sessionPtyProcessIds, WorktreeDeleteDiagnosticsReader } from './delete-diagnostics.js';
import { WorkspaceError } from './errors.js';
import {
  commandCleanup,
  requireProjectRootWorktree,
  requireProjectWorktree,
  requireUsableGitProject,
} from './project-guards.js';

/** How long a deleted worktree's session processes get to exit before they are killed. */
const sessionTerminationGraceMs = 1_000;

/**
 * Deleting a worktree, and the preflight that tells a person what deleting it would do.
 *
 * Destructive sequencing is deliberate: the worktree is validated first, then its command processes are stopped, its
 * active session processes terminated, the Git worktree removed, and the row deleted so dependent state cascades;
 * only then is the branch deleted, if asked and safe. `checkoutRemovalMode: "force"` does not force branch deletion.
 */
export const worktreeDelete = Effect.gen(function* () {
  const repository = yield* ProjectRepository;
  const git = yield* Git;
  const commands = yield* CommandService;
  const pty = yield* PtyService;
  const agents = yield* AgentSessionService;
  const deleteDiagnostics = yield* WorktreeDeleteDiagnosticsReader;
  const internalEvents = yield* InternalEvents;
  const sessionDeletions = yield* durableSessionDeletions;

  return {
    preflightDeleteWorktree: Effect.fn('WorkspaceService.preflightDeleteWorktree')(
      function* (input: { readonly projectId: number; readonly worktreeId: number }) {
        const project = yield* requireUsableGitProject(repository, input.projectId);
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
      },
    ),
    deleteWorktree: Effect.fn('WorkspaceService.deleteWorktree')(
      function* (input: {
        readonly projectId: number;
        readonly worktreeId: number;
        readonly request: DeleteWorktreeInput;
      }) {
        const project = yield* requireUsableGitProject(repository, input.projectId);
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
          return yield* new WorkspaceError({
            code: 'root_worktree_not_deletable',
            message: `Root worktree ${worktree.id} cannot be deleted.`,
            projectId: project.id,
            worktreeId: worktree.id,
            path: worktree.path,
          });
        }

        const dirty = yield* checkoutIsDirty(git, worktree.path);
        if (dirty && input.request.checkoutRemovalMode === 'normal') {
          return yield* new WorkspaceError({
            code: 'dirty_checkout_requires_force',
            message: `Worktree ${worktree.id} has uncommitted or untracked changes.`,
            projectId: project.id,
            worktreeId: worktree.id,
            path: worktree.path,
          });
        }

        const diagnostics = yield* deleteDiagnostics.read(worktree.id);
        const doomedSessions = yield* sessionDeletions.inWorktrees(new Set([worktree.id]));
        yield* Effect.logDebug('workspace.delete_worktree.delete_diagnostics').pipe(
          Effect.annotateLogs({
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
          }),
        );
        yield* diagnosticPhase(
          'workspace.delete_worktree.command_cleanup',
          context,
          commandCleanup(
            commands.cleanupBeforeWorktreeDelete({ worktreeId: worktree.id }),
            worktree.id,
            project.id,
          ),
        );
        // The worktree is held against new agent controllers from before the release until the
        // cascade commits or fails; the scope removes only this delete's hold. The agents to
        // release are read after the hold: an agent created later cannot switch, and one switched
        // earlier is in this read. Workers stop before `git worktree remove`.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* agents.holdWorktreesForDeletion([worktree.id]);
            const held = yield* deleteDiagnostics.read(worktree.id);
            yield* diagnosticPhase(
              'workspace.delete_worktree.agent_release',
              context,
              agents.releaseControllers(held.agentSessionIds),
            );
            yield* diagnosticPhase(
              'workspace.delete_worktree.pty_teardown',
              context,
              terminateSessionPtys(pty, {
                operation: 'worktree_delete',
                ptyProcessIds: sessionPtyProcessIds(diagnostics),
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
          }),
        );
        // Announced only after the cascade commits: every connected client — not just
        // the one that asked — drops the terminals these identities backed.
        yield* sessionDeletions.publish(doomedSessions);
        yield* internalEvents.publish({
          type: 'worktree_deleted',
          worktreeId: worktree.id,
          projectId: project.id,
        });
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
      },
      (effect, input) =>
        diagnosticPhase(
          'workspace.delete_worktree',
          {
            projectId: input.projectId,
            worktreeId: input.worktreeId,
            checkoutRemovalMode: input.request.checkoutRemovalMode,
            branchRemovalMode: input.request.branchRemovalMode,
          },
          effect,
        ),
    ),
  };
});

/**
 * The durable identities a worktree owns, read before its row is deleted, and their announcement after. The DB cascade
 * removes those rows silently, so any client that is not the one issuing the delete would otherwise never learn its
 * cached terminals are gone. Shared by worktree and project deletion.
 */
export const durableSessionDeletions = Effect.gen(function* () {
  const surfaces = yield* SurfaceService;
  const internalEvents = yield* InternalEvents;
  return {
    inWorktrees: (worktreeIds: ReadonlySet<number>) =>
      surfaces.listDurableSessions.pipe(
        Effect.map((inventory) =>
          inventory.sessions.filter((session) => worktreeIds.has(session.worktreeId)),
        ),
      ),
    publish: (identities: readonly DurableSessionIdentity[]): Effect.Effect<void> =>
      Effect.forEach(
        identities,
        (identity) => internalEvents.publish({ type: 'durable_session_deleted', identity }),
        { discard: true },
      ),
  };
});

function isRootWorktree(project: ProjectRow, worktree: WorktreeRow) {
  return worktree.path === project.rootPath;
}

function checkoutIsDirty(git: Git['Service'], checkoutPath: string) {
  return git
    .run(['-C', checkoutPath, 'status', '--porcelain'])
    .pipe(Effect.map(({ stdout }) => stdout.trim().length > 0));
}

function deleteBranchIfRequested(
  git: Git['Service'],
  project: ProjectRow,
  worktree: WorktreeRow,
  request: DeleteWorktreeInput,
): Effect.Effect<DeleteWorktreeOutput['branchRemoval']> {
  if (request.branchRemovalMode === 'preserve') {
    return Effect.succeed({ status: 'not_requested' });
  }
  if (!worktree.branch) {
    return Effect.succeed({ status: 'not_applicable' });
  }

  return git.run(['-C', project.rootPath, 'branch', '-d', worktree.branch]).pipe(
    Effect.as({ status: 'deleted' as const, branch: worktree.branch }),
    // A refused branch delete is reported in the result, not as a failure: the worktree is already gone.
    Effect.catchTag('GitCommandError', (error) =>
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

/**
 * Stops the live agent and terminal processes of worktrees about to be deleted. Their session rows cascade away with
 * the worktree, and nothing else would ever stop them. Shared by worktree and project deletion.
 */
export function terminateSessionPtys(
  pty: PtyService['Service'],
  input: {
    readonly operation: 'worktree_delete' | 'project_delete';
    readonly ptyProcessIds: readonly number[];
    readonly projectId: number;
    readonly worktreeId?: number;
  },
) {
  return pty
    .terminateMany({
      failurePolicy: 'required',
      gracefulTimeoutMs: sessionTerminationGraceMs,
      operation: input.operation,
      ptyProcessIds: input.ptyProcessIds,
    })
    .pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceError({
            code: 'pty_teardown_failed',
            message:
              input.worktreeId === undefined
                ? `Could not stop active sessions for project ${input.projectId}.`
                : `Could not stop active sessions for worktree ${input.worktreeId}.`,
            projectId: input.projectId,
            worktreeId: input.worktreeId,
            cause: error,
          }),
      ),
    );
}
