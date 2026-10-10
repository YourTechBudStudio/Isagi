import { existsSync, statSync } from 'node:fs';

import { Effect } from 'effect';

import type {
  ReconcileWorkspaceInput,
  ReconcileWorkspaceOutput,
  ReconciliationFinding,
} from '@isagi/contracts';

import { CommandService } from '../commands/index.js';
import { InternalEvents } from '../platform/events/index.js';
import { Git, type GitCommandError, listGitWorktrees } from '../platform/git/index.js';
import {
  ProjectRepository,
  type DiscoveredWorktree,
  type ProjectRow,
  type WorkspaceReconcileProjectWorktreesResult,
  type WorktreeRow,
} from '../projects/index.js';
import { directoryAvailability } from './directory-availability.js';
import { commandCleanup, requireProject } from './project-guards.js';

/**
 * Bringing durable project and worktree rows back in line with the world: the `reconcileWorkspace` method, and the
 * per-project reconciliation that registration, relocation, worktree creation and detached creation run after they
 * change what is on disk.
 *
 * How a project is reconciled depends on who owns its environments. A Git project is reconciled *against Git*, which
 * discovers its membership. A folder project owns exactly one environment that the runtime created alongside the
 * project itself, so there is nothing to discover and nothing to prune — only whether the directory is still there.
 */
export const reconciliation = Effect.gen(function* () {
  const repository = yield* ProjectRepository;
  const commands = yield* CommandService;
  const internalEvents = yield* InternalEvents;
  const git = yield* Git;

  /**
   * Presence, and nothing else. It reads no worktree rows, runs no Git, emits no
   * worktree findings and never calls command cleanup, because every one of those
   * identifies membership by path — which would hand filesystem discovery
   * authority over an environment the runtime owns.
   *
   * There is deliberately no repair step for a missing singleton: creation is
   * atomic and no supported path deletes the row, so a reconciler able to
   * recreate it could only ever paper over database corruption, which the
   * architecture puts out of scope.
   */
  const reconcileFolderProject = Effect.fnUntraced(function* (project: ProjectRow) {
    const findings: ReconciliationFinding[] = [];
    const availability = directoryAvailability(project.rootPath);

    if (!availability.available) {
      if (project.status !== 'missing') {
        findings.push({ kind: 'project_missing', projectId: project.id, path: project.rootPath });
      }
      yield* repository.setProjectStatus({
        id: project.id,
        missingReason: availability.reason,
        status: 'missing',
      });
      return findings;
    }

    if (project.status === 'missing') {
      findings.push({ kind: 'project_restored', projectId: project.id, path: project.rootPath });
    }
    yield* repository.setProjectStatus({ id: project.id, status: 'present' });
    return findings;
  });

  /**
   * Deletes the rows of worktrees reconciliation found gone, each after its commands are stopped, and announces each
   * deletion.
   */
  const pruneMissingWorktrees = Effect.fnUntraced(function* (
    projectId: number,
    worktrees: readonly Pick<WorktreeRow, 'id'>[],
  ) {
    for (const worktree of worktrees) {
      yield* commandCleanup(
        commands.cleanupBeforeWorktreePrune({ worktreeId: worktree.id }),
        worktree.id,
        projectId,
      );
      const current = yield* repository.findWorktree(worktree.id);
      if (current) {
        yield* repository.deleteWorktree(worktree.id);
        // Reconciliation deletes a worktree just as deliberately as a person does, and a run placed
        // in it is just as gone. Announcing it here too is what keeps the notification a property of
        // the deletion rather than of which caller performed it.
        yield* internalEvents.publish({
          type: 'worktree_deleted',
          worktreeId: worktree.id,
          projectId,
        });
      }
    }
  });

  const discover = (project: Pick<ProjectRow, 'rootPath'>) =>
    discoverWorktrees(project).pipe(Effect.provideService(Git, git));

  const reconcileGitProject = Effect.fnUntraced(function* (project: ProjectRow) {
    const findings: ReconciliationFinding[] = [];

    const availability = directoryAvailability(project.rootPath);
    if (!availability.available) {
      if (project.status !== 'missing') {
        findings.push({ kind: 'project_missing', projectId: project.id, path: project.rootPath });
      }
      yield* repository.setProjectStatus({
        id: project.id,
        missingReason: availability.reason,
        status: 'missing',
      });
      return findings;
    }

    const discovery = yield* discover(project).pipe(
      Effect.match({
        onFailure: (error) => ({ status: 'failed' as const, error }),
        onSuccess: (discovered) => ({ status: 'succeeded' as const, discovered }),
      }),
    );
    if (discovery.status === 'failed') {
      if (project.status !== 'missing') {
        findings.push({ kind: 'project_missing', projectId: project.id, path: project.rootPath });
      }
      const missingReason = describeWorktreeDiscoveryFailure(project.rootPath, discovery.error);
      // Git's stderr may echo user data, so it reaches only the project's own missing reason, never the log.
      yield* Effect.logError('Could not read Git worktrees; marking the project missing').pipe(
        Effect.annotateLogs({
          projectId: project.id,
          rootPath: project.rootPath,
          gitFailure: discovery.error.failure.kind,
        }),
      );
      yield* repository.setProjectStatus({
        id: project.id,
        missingReason,
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
    yield* pruneMissingWorktrees(project.id, worktrees.missing);

    findings.push(...reconciliationFindingsFromWorktreeResult(project.id, worktrees));

    return findings;
  });

  const reconcileProject = (project: ProjectRow) =>
    project.kind === 'folder' ? reconcileFolderProject(project) : reconcileGitProject(project);

  return {
    reconcileProject,
    pruneMissingWorktrees,
    discoverWorktrees: discover,
    reconcileWorkspace: Effect.fn('WorkspaceService.reconcileWorkspace')(function* (
      input: ReconcileWorkspaceInput,
    ) {
      const projects = input.projectId
        ? [yield* requireProject(repository, input.projectId)]
        : yield* repository.listProjects;
      const findings: ReconciliationFinding[] = [];

      for (const project of projects) {
        findings.push(...(yield* reconcileProject(project)));
      }

      return { findings } satisfies ReconcileWorkspaceOutput;
    }),
  };
});

export function reconciliationFindingsFromWorktreeResult(
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

function discoverWorktrees(project: Pick<ProjectRow, 'rootPath'>) {
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
