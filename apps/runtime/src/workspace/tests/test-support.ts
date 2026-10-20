import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { Effect, Stream } from 'effect';

import type { DurableSessionIdentity } from '@isagi/contracts';

import type { CommandService } from '../../commands/index.js';
import type { AgentSessionService, SurfaceService } from '../../environment/index.js';
import type { InternalEvent, InternalEvents } from '../../platform/events/index.js';
import type { Git } from '../../platform/git/index.js';
import { makeTestDataDirectory } from '../../platform/persistence/testing.js';
import type { ProjectRow, WorktreeRow, ProjectRepository } from '../../projects/index.js';
import type { PtyService } from '../../pty-processes/index.js';
import { fakeTerminateMany } from '../../pty-processes/testing.js';
import {
  WorktreeDeleteDiagnosticsReader,
  type WorktreeDeleteDiagnostics,
} from '../delete-diagnostics.js';
import type { WorktreeSetupRepository } from '../setup/repository.js';
import type { WorktreeSetupService } from '../setup/service.js';
import { stateFromActiveContext, type StateFile } from '../state-file.js';

export const project: ProjectRow = {
  id: 1,
  name: 'Isagi',
  rootPath: '/repo/isagi',
  kind: 'git',
  status: 'present',
  createdAt: '2026-06-04T00:00:00.000Z',
  updatedAt: '2026-06-04T00:00:00.000Z',
  lastSeenAt: '2026-06-04T00:00:00.000Z',
  missingReason: null,
};

export const worktree: WorktreeRow = {
  id: 10,
  projectId: project.id,
  path: '/repo/isagi',
  branch: 'main',
  head: 'abc123456789',
  createdAt: '2026-06-04T00:00:00.000Z',
  updatedAt: '2026-06-04T00:00:00.000Z',
  firstSeenAt: '2026-06-04T00:00:00.000Z',
  lastSeenAt: '2026-06-04T00:00:00.000Z',
};

export const featureWorktree: WorktreeRow = {
  ...worktree,
  id: 11,
  path: '/repo/isagi-feature',
  branch: 'feature/delete-me',
};

export const git = {
  run: () => Effect.die(new Error('git should not be called by active context persistence')),
} satisfies Git['Service'];

export const testDataDirectory = makeTestDataDirectory('/tmp/isagi-test');

export const testWorktreeSetup = {
  preflight: (candidate) =>
    Effect.succeed({ projectId: candidate.id, status: 'not_configured', summary: [] }),
  updateTrust: (input) =>
    Effect.succeed({
      projectId: input.project.id,
      status: input.request.action === 'disable_hooks' ? 'disabled' : 'trusted',
      ...(input.request.action === 'disable_hooks' ? {} : { hash: input.request.hash }),
    }),
  validateTrustForOpen: () => Effect.succeed({ status: 'not_configured' as const }),
} satisfies WorktreeSetupService['Service'];

export const testWorktreeSetupRepository = {
  findTrust: () => Effect.succeed(null),
  setTrustedHash: () => Effect.void,
  disableHooks: () => Effect.void,
  createRunWithSteps: () => Effect.succeed(1),
  listRunSteps: () => Effect.succeed([]),
} satisfies WorktreeSetupRepository['Service'];

export const testSurfaceService = {
  findSurface: () => Effect.succeed(null),
  listWorkspaceSurfaceMetadata: Effect.succeed([]),
  listEnvironmentFocusStates: Effect.succeed([]),
  listDurableSessions: Effect.succeed({ sessions: [] }),
  restorePaneBoundSessions: Effect.die('session restore is not used by workspace tests'),
  getSurfaceDetail: () => Effect.die('surface detail is not used by workspace tests'),
  renameSurface: () => Effect.die('surface rename is not used by workspace tests'),
  deleteSurface: () => Effect.die('surface delete is not used by workspace tests'),
  deleteSurfacePane: () => Effect.die('surface pane delete is not used by workspace tests'),
  createSurface: () => Effect.die('surface creation is not used by workspace tests'),
  splitPane: () => Effect.die('surface split is not used by workspace tests'),
  startPane: () => Effect.die('surface pane start is not used by workspace tests'),
  setSplitWeights: () => Effect.die('surface layout update is not used by workspace tests'),
  createPaneSession: () => Effect.die('surface pane session create is not used by workspace tests'),
  claimPaneSession: () => Effect.die('surface pane session claim is not used by workspace tests'),
  createSinglePaneSurface: () => Effect.die('surface creation is not used by workspace tests'),
  createEmptySurface: () => Effect.die('surface creation is not used by workspace tests'),
  setWorktreeEnvironmentFocus: () => Effect.die('surface focus is not used by workspace tests'),
  moveSurfaceOrder: () => Effect.die('surface reorder is not used by workspace tests'),
  openEditor: () => Effect.die('openEditor is not used by workspace tests'),
} satisfies SurfaceService['Service'];

/** The surface fake, answering the durable session inventory with `durableSessions`. */
export function surfaceServiceWith(input: {
  readonly durableSessions: readonly DurableSessionIdentity[];
}): SurfaceService['Service'] {
  return {
    ...testSurfaceService,
    listDurableSessions: Effect.succeed({ sessions: [...input.durableSessions] }),
  };
}

/**
 * The agent-session fake a workspace delete sees. With no agent controllers in these tests, holding
 * and releasing do nothing; `recordingAgentSessionService` records them for the delete tests.
 */
export const testAgentSessionService = {
  startFresh: () => Effect.die('agent startFresh is not used by workspace tests'),
  get: () => Effect.die('agent get is not used by workspace tests'),
  ensureActivePtyProcess: () =>
    Effect.die('agent ensureActivePtyProcess is not used by workspace tests'),
  requireTerminalMode: () => Effect.die('agent requireTerminalMode is not used by workspace tests'),
  withRunningTerminal: () => Effect.die('agent withRunningTerminal is not used by workspace tests'),
  isControllerLive: () => Effect.die('agent isControllerLive is not used by workspace tests'),
  stopUnlessPlaced: () => Effect.die('agent stopUnlessPlaced is not used by workspace tests'),
  setInteractionMode: () => Effect.die('agent setInteractionMode is not used by workspace tests'),
  releaseControllers: () => Effect.void,
  holdWorktreesForDeletion: () => Effect.void,
  holdProjectForDeletion: () => Effect.void,
} satisfies AgentSessionService['Service'];

/** Records each hold (and when its scope ends) and each release into `log`, in order. */
export function recordingAgentSessionService(log: string[]): AgentSessionService['Service'] {
  return {
    ...testAgentSessionService,
    holdWorktreesForDeletion: (ids) =>
      Effect.acquireRelease(
        Effect.sync(() => void log.push(`hold:${ids.join(',')}`)),
        () => Effect.sync(() => void log.push(`unhold:${ids.join(',')}`)),
      ),
    holdProjectForDeletion: (projectId) =>
      Effect.acquireRelease(
        Effect.sync(() => void log.push(`hold-project:${projectId}`)),
        () => Effect.sync(() => void log.push(`unhold-project:${projectId}`)),
      ),
    releaseControllers: (ids) => Effect.sync(() => void log.push(`release:${ids.join(',')}`)),
  };
}

export const noWorktreeDeleteDiagnostics: WorktreeDeleteDiagnostics = {
  agentSessionCount: 0,
  agentSessionIds: [],
  agentSessionActivePtyProcessIds: [],
  commandRunCount: 0,
  commandRunPtyProcessIds: [],
  commandStateCount: 0,
  commandStateActivePtyProcessIds: [],
  paneCount: 0,
  surfaceCount: 0,
  terminalSessionCount: 0,
  terminalSessionActivePtyProcessIds: [],
};

/** The delete-diagnostics read, answering every worktree with `diagnostics`. */
export function worktreeDeleteDiagnosticsWith(
  diagnostics: WorktreeDeleteDiagnostics,
): WorktreeDeleteDiagnosticsReader['Service'] {
  return WorktreeDeleteDiagnosticsReader.of({ read: () => Effect.succeed(diagnostics) });
}

/** A worktree whose delete would cascade through nothing. */
export const testWorktreeDeleteDiagnostics = worktreeDeleteDiagnosticsWith(
  noWorktreeDeleteDiagnostics,
);

export const testCommandService = {
  listForWorktree: () => Effect.die('command list is not used by workspace tests'),
  readLogMetadata: () => Effect.die('command log metadata is not used by workspace tests'),
  run: () => Effect.die('command run is not used by workspace tests'),
  stop: () => Effect.die('command stop is not used by workspace tests'),
  restart: () => Effect.die('command restart is not used by workspace tests'),
  runPostCreateLifecycle: () => Effect.void,
  cleanupBeforeWorktreeDelete: () => Effect.void,
  cleanupBeforeWorktreePrune: () => Effect.void,
} satisfies CommandService['Service'];

export const testPtyService = {
  allocateLaunch: () => Effect.die('pty allocateLaunch is not used'),
  readLogTail: () => Effect.die('readLogTail is not used'),
  launch: () => Effect.die('pty launch is not used by workspace tests'),
  getAttachmentPlan: () => Effect.die('pty attachment planning is not used by workspace tests'),
  attach: () => Effect.die('pty attach is not used by workspace tests'),
  replay: () => Effect.die('pty replay is not used by workspace tests'),
  write: () => Effect.die('pty write is not used by workspace tests'),
  writeInput: () => Effect.die('pty write input is not used by workspace tests'),
  resize: () => Effect.die('pty resize is not used by workspace tests'),
  kill: () => Effect.succeed('terminated_live' as const),
  terminate: () => Effect.succeed('terminated_live' as const),
  terminateMany: fakeTerminateMany(() => Effect.succeed('terminated_live' as const)),
  findProcess: () => Effect.die('pty findProcess is not used by workspace tests'),
  cleanupProcess: () => Effect.die('pty cleanupProcess is not used by workspace tests'),
  pin: () => Effect.void,
  unpin: () => Effect.void,
  isPinned: () => Effect.succeed(false),
} satisfies PtyService['Service'];

export const testInternalEvents = {
  publish: () => Effect.void,
  subscribe: () => Effect.succeed(Stream.never),
} satisfies InternalEvents['Service'];

/** An event bus that keeps what was published, so ordering against the DB cascade is assertable. */
export function recordingInternalEvents() {
  const published: InternalEvent[] = [];
  return {
    published,
    service: {
      publish: (event: InternalEvent) =>
        Effect.sync(() => {
          published.push(event);
        }),
      subscribe: () => Effect.succeed(Stream.never),
    } satisfies InternalEvents['Service'],
  };
}

export function repositoryWith(input: {
  readonly project: ProjectRow | null;
  readonly worktree: WorktreeRow | null;
}): ProjectRepository['Service'] {
  return {
    findProject: (projectId) =>
      Effect.succeed(input.project && input.project.id === projectId ? input.project : null),
    findProjectByRootPath: () => Effect.succeed(input.project),
    findWorktree: (worktreeId) =>
      Effect.succeed(input.worktree && input.worktree.id === worktreeId ? input.worktree : null),
    findProjectWorktree: (lookup) =>
      Effect.succeed(
        input.worktree &&
          input.worktree.projectId === lookup.projectId &&
          input.worktree.id === lookup.worktreeId
          ? input.worktree
          : null,
      ),
    findProjectRootWorktree: (lookup) =>
      Effect.succeed(
        input.worktree &&
          input.worktree.projectId === lookup.projectId &&
          input.worktree.path === lookup.rootPath
          ? input.worktree
          : null,
      ),
    findProjectWorktreeByBranch: (lookup) =>
      Effect.succeed(
        input.worktree &&
          input.worktree.projectId === lookup.projectId &&
          input.worktree.branch === lookup.branch
          ? input.worktree
          : null,
      ),
    findProjectWorktreeByPath: (lookup) =>
      Effect.succeed(
        input.worktree &&
          input.worktree.projectId === lookup.projectId &&
          input.worktree.path === lookup.path
          ? input.worktree
          : null,
      ),
    deleteProject: () => Effect.succeed(false),
    deleteWorktree: () => Effect.succeed(false),
    createProject: () => Effect.succeed(project),
    listProjects: Effect.succeed(input.project ? [input.project] : []),
    listWorktrees: Effect.succeed(input.worktree ? [input.worktree] : []),
    reconcileProjectWorktrees: () => Effect.succeed({ added: [], missing: [] }),
    restoreProjectAtRootPath: () => Effect.succeed({ added: [], missing: [] }),
    setProjectStatus: () => Effect.void,
    moveProjectOrder: () => Effect.succeed({ status: 'moved' }),
    moveProjectWorktreeOrder: () => Effect.succeed({ status: 'moved' }),
  };
}

export function repositoryWithWorktrees(input: {
  readonly project: ProjectRow;
  readonly worktrees: readonly WorktreeRow[];
}): ProjectRepository['Service'] {
  return {
    findProject: (projectId) =>
      Effect.succeed(input.project.id === projectId ? input.project : null),
    findProjectByRootPath: (rootPath) =>
      Effect.succeed(input.project.rootPath === rootPath ? input.project : null),
    findWorktree: (worktreeId) =>
      Effect.succeed(input.worktrees.find((candidate) => candidate.id === worktreeId) ?? null),
    findProjectWorktree: (lookup) =>
      Effect.succeed(
        input.worktrees.find(
          (candidate) =>
            candidate.projectId === lookup.projectId && candidate.id === lookup.worktreeId,
        ) ?? null,
      ),
    findProjectRootWorktree: (lookup) =>
      Effect.succeed(
        input.worktrees.find(
          (candidate) =>
            candidate.projectId === lookup.projectId && candidate.path === lookup.rootPath,
        ) ?? null,
      ),
    findProjectWorktreeByBranch: (lookup) =>
      Effect.succeed(
        input.worktrees.find(
          (candidate) =>
            candidate.projectId === lookup.projectId && candidate.branch === lookup.branch,
        ) ?? null,
      ),
    findProjectWorktreeByPath: (lookup) =>
      Effect.succeed(
        input.worktrees.find(
          (candidate) => candidate.projectId === lookup.projectId && candidate.path === lookup.path,
        ) ?? null,
      ),
    deleteProject: () => Effect.succeed(false),
    deleteWorktree: () => Effect.succeed(true),
    createProject: () => Effect.succeed(input.project),
    listProjects: Effect.succeed([input.project]),
    listWorktrees: Effect.succeed([...input.worktrees]),
    reconcileProjectWorktrees: () => Effect.succeed({ added: [], missing: [] }),
    restoreProjectAtRootPath: () => Effect.succeed({ added: [], missing: [] }),
    setProjectStatus: () => Effect.void,
    moveProjectOrder: () => Effect.succeed({ status: 'moved' }),
    moveProjectWorktreeOrder: () => Effect.succeed({ status: 'moved' }),
  };
}

export function deleteFixtures() {
  const rootPath = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-delete-worktree-')));
  const fixtureProject = { ...project, rootPath };
  const rootWorktree = { ...worktree, path: rootPath };
  const targetWorktree = {
    ...featureWorktree,
    path: join(rootPath, '../isagi-feature'),
  };
  return {
    project: fixtureProject,
    rootWorktree,
    targetWorktree,
    cleanup: () => rmSync(rootPath, { recursive: true, force: true }),
  };
}

export function stateFileWithWriteCounter(
  onWrite: () => void,
  initialState = stateFromActiveContext(null, null, 0),
): StateFile['Service'] {
  let state = initialState;

  return {
    read: Effect.sync(() => state),
    write: (nextState) =>
      Effect.sync(() => {
        state = nextState;
        onWrite();
      }),
    writeActiveContextIfFresh: (input) =>
      Effect.sync(() => {
        if (input.revision > state.workspace.activeContextRevision) {
          state = stateFromActiveContext(
            input.activeProjectId,
            input.activeWorktreeId,
            input.revision,
          );
          onWrite();
        }
        return state;
      }),
  };
}

/**
 * Every path beneath `root`, relative and sorted, with directories marked and
 * files carried by content hash.
 *
 * The instrument for "Isagi did not touch the user's folder": a created `.git`,
 * a copied template, a stray lock file, a truncated file or a rewritten one all
 * show up as a diff of two of these, rather than as whichever single check
 * someone thought to write.
 */
export function directoryTree(root: string): string[] {
  const entries: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolute = join(directory, entry.name);
      const relativePath = relative(root, absolute);
      if (entry.isDirectory()) {
        entries.push(`d ${relativePath}`);
        walk(absolute);
      } else {
        const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
        entries.push(`f ${relativePath} ${digest}`);
      }
    }
  };
  walk(root);
  return entries;
}
