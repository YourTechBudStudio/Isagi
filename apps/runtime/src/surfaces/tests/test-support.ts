import { eq } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import {
  AgentSessionAttentionProjectionLive,
  AgentSessionArtifacts,
  AgentSessionArtifactsLive,
  AgentSessionService,
  type AgentSessionServiceShape,
} from '../../agent-sessions/index.js';
import { DataDirectory, RuntimeDatabase, RuntimeDatabaseLive } from '../../persistence/index.js';
import {
  agentSessions,
  ptyProcesses,
  surfacePanes,
  terminalSessions,
  worktreeSurfaces,
} from '../../persistence/schema.js';
import { makeTestDataDirectory } from '../../persistence/test-support.js';
import { PtyForegroundStateLive } from '../../pty-processes/index.js';
import { InternalRuntimeEventBusLive } from '../../runtime-events/index.js';
import { SessionLifecycleLive } from '../../session-lifecycle/index.js';
import {
  TerminalSessionService,
  type TerminalSessionServiceShape,
} from '../../terminal-sessions/index.js';
import { WorkspaceRepository, WorkspaceRepositoryLive } from '../../workspace/index.js';
import { SurfaceRepositoryLive, SurfaceServiceLive } from '../index.js';

export function insertWorktree(rootPath: string) {
  return Effect.gen(function* () {
    const workspaceRepository = yield* WorkspaceRepository;
    const projectId = yield* workspaceRepository.insertProject({ name: 'isagi', rootPath });
    yield* workspaceRepository.reconcileProjectWorktrees({
      projectId,
      discovered: [{ path: rootPath, branch: 'main', head: 'abcdef0' }],
    });
    const worktrees = yield* workspaceRepository.listWorktrees;
    const worktree = worktrees.find((candidate) => candidate.projectId === projectId);
    if (!worktree) {
      return yield* Effect.die('Expected test worktree to be inserted.');
    }
    return worktree.id;
  });
}

export function replaceSurfaceLayoutWithSingleDeletedPane(surfaceId: number, paneId: number) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_replace_surface_layout_with_single_deleted_pane', (db) => {
      db.update(worktreeSurfaces)
        .set({
          layoutJson: JSON.stringify({
            kind: 'leaf',
            nodeId: `pane-${paneId}`,
            paneId,
            collapsed: false,
          }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(worktreeSurfaces.id, surfaceId))
        .run();
    });
  });
}

export function addPaneToSurface(surfaceId: number) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_add_surface_pane', (db) => {
      const now = new Date().toISOString();
      const pane = db
        .insert(surfacePanes)
        .values({
          surfaceId,
          title: 'Second pane',
          sortOrder: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: surfacePanes.id })
        .get();
      const surface = db
        .select({ layoutJson: worktreeSurfaces.layoutJson })
        .from(worktreeSurfaces)
        .where(eq(worktreeSurfaces.id, surfaceId))
        .get();
      if (!surface) {
        throw new Error(`Missing test surface ${surfaceId}.`);
      }
      const existingLayout = JSON.parse(surface.layoutJson);
      db.update(worktreeSurfaces)
        .set({
          layoutJson: JSON.stringify({
            kind: 'split',
            nodeId: `split-${surfaceId}`,
            axis: 'row',
            sizing: 'manual',
            children: [
              existingLayout,
              {
                kind: 'leaf',
                nodeId: `pane-${pane.id}`,
                paneId: pane.id,
                collapsed: false,
              },
            ],
            weights: [0.4, 0.6],
          }),
          updatedAt: now,
        })
        .where(eq(worktreeSurfaces.id, surfaceId))
        .run();
      return pane.id;
    });
  });
}

export function insertAgentSessionForWorktree(input: {
  readonly worktreeId: number;
  readonly paneId: number;
}) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const artifacts = yield* AgentSessionArtifacts;
    const sessionId = yield* database.use('test_insert_agent_session_for_pane', (db) => {
      const now = new Date().toISOString();
      const session = db
        .insert(agentSessions)
        .values({
          worktreeId: input.worktreeId,
          harness: 'pi',
          cwd: '/repo/isagi',
          activePtyProcessId: null,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: null,
        })
        .returning({ id: agentSessions.id })
        .get();
      db.update(surfacePanes)
        .set({ sessionKind: 'agent_session', sessionId: session.id, updatedAt: now })
        .where(eq(surfacePanes.id, input.paneId))
        .run();
      return session.id;
    });
    yield* artifacts.initializeMetadata(sessionId);
    return sessionId;
  });
}

export function insertPtyProcess(input: {
  readonly paneId: number;
  readonly worktreeId: number;
  readonly logPath: string | null;
  readonly status: 'starting' | 'running' | 'exited' | 'failed' | 'killed';
}) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_insert_pty_process_terminal_session', (db) => {
      const now = new Date().toISOString();
      const process = db
        .insert(ptyProcesses)
        .values({
          backend: 'node_pty',
          backendRefJson: JSON.stringify({
            schemaVersion: 1,
            backend: 'node_pty',
            ptyProcessId: 0,
            pid: null,
          }),
          command: 'bash',
          argsJson: JSON.stringify([]),
          cwd: '/repo/isagi',
          status: input.status,
          statusReason: null,
          exitCode: input.status === 'exited' ? 0 : null,
          signal: null,
          logMode: input.logPath ? 'backend_file' : 'none',
          logPath: input.logPath,
          createdAt: now,
          updatedAt: now,
          exitedAt:
            input.status === 'exited' || input.status === 'failed' || input.status === 'killed'
              ? now
              : null,
          lastSeenAt: null,
        })
        .returning({ id: ptyProcesses.id })
        .get();
      db.update(ptyProcesses)
        .set({
          backendRefJson: JSON.stringify({
            schemaVersion: 1,
            backend: 'node_pty',
            ptyProcessId: process.id,
            pid: null,
          }),
        })
        .where(eq(ptyProcesses.id, process.id))
        .run();
      const session = db
        .insert(terminalSessions)
        .values({
          worktreeId: input.worktreeId,
          cwd: '/repo/isagi',
          shellCommand: 'bash',
          shellArgsJson: JSON.stringify([]),
          activePtyProcessId: process.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: terminalSessions.id })
        .get();
      db.update(surfacePanes)
        .set({ sessionKind: 'terminal_session', sessionId: session.id, updatedAt: now })
        .where(eq(surfacePanes.id, input.paneId))
        .run();
      return session.id;
    });
  });
}

export function testLayer(
  dataRoot: string,
  options: {
    readonly agentService?: Partial<AgentSessionServiceShape> | undefined;
    readonly terminalService?: Partial<TerminalSessionServiceShape> | undefined;
  } = {},
) {
  const dataDirectory = makeTestDataDirectory(dataRoot);

  const dataDirectoryLayer = Layer.succeed(DataDirectory, dataDirectory);
  const internalRuntimeEventBus = InternalRuntimeEventBusLive;
  const agentSessionArtifacts = AgentSessionArtifactsLive.pipe(Layer.provide(dataDirectoryLayer));
  const database = RuntimeDatabaseLive.pipe(Layer.provide(dataDirectoryLayer));
  const attentionProjection = AgentSessionAttentionProjectionLive.pipe(
    Layer.provide(dataDirectoryLayer),
    Layer.provide(database),
    Layer.provide(agentSessionArtifacts),
    Layer.provide(PtyForegroundStateLive),
    Layer.provide(internalRuntimeEventBus),
  );
  const workspaceRepository = WorkspaceRepositoryLive.pipe(Layer.provide(database));
  const agentService = Layer.succeed(
    AgentSessionService,
    fakeAgentSessionService(options.agentService),
  );
  const terminalService = Layer.succeed(
    TerminalSessionService,
    fakeTerminalSessionService(options.terminalService),
  );
  const surfaceRepository = SurfaceRepositoryLive.pipe(
    Layer.provide(database),
    Layer.provide(agentSessionArtifacts),
    Layer.provide(attentionProjection),
  );
  const sessionLifecycle = SessionLifecycleLive;
  const surfaceService = SurfaceServiceLive.pipe(
    Layer.provide(surfaceRepository),
    Layer.provide(agentService),
    Layer.provide(terminalService),
    Layer.provide(sessionLifecycle),
    Layer.provide(internalRuntimeEventBus),
  );
  return Layer.mergeAll(
    database,
    agentSessionArtifacts,
    attentionProjection,
    internalRuntimeEventBus,
    workspaceRepository,
    surfaceRepository,
    surfaceService,
    sessionLifecycle,
  );
}

function fakeAgentSessionService(
  overrides: Partial<AgentSessionServiceShape> = {},
): AgentSessionServiceShape {
  return {
    startFresh: () => Effect.die('agent startFresh is not used by surface service tests'),
    get: () => Effect.die('agent get is not used by surface service tests'),
    ensureActivePtyProcess: () =>
      Effect.die('agent ensureActivePtyProcess is not used by surface service tests'),
    activePtyProcessId: () =>
      Effect.die('agent activePtyProcessId is not used by surface service tests'),
    ...overrides,
  } satisfies AgentSessionServiceShape;
}

function fakeTerminalSessionService(
  overrides: Partial<TerminalSessionServiceShape> = {},
): TerminalSessionServiceShape {
  return {
    startFresh: () => Effect.die('terminal startFresh is not used by surface service tests'),
    get: () => Effect.die('terminal get is not used by surface service tests'),
    ensureActivePtyProcess: () =>
      Effect.die('terminal ensureActivePtyProcess is not used by surface service tests'),
    activePtyProcessId: () =>
      Effect.die('terminal activePtyProcessId is not used by surface service tests'),
    ...overrides,
  } satisfies TerminalSessionServiceShape;
}

export function agentSessionRowForTest(input: {
  readonly id: number;
  readonly worktreeId: number;
}) {
  return {
    id: input.id,
    worktreeId: input.worktreeId,
    harness: 'pi' as const,
    cwd: '/repo/isagi',
    harnessSessionId: null,
    harnessMetadataStatus: 'valid' as const,
    harnessMetadataDiagnostic: null,
    activePtyProcessId: null,
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
    lastSeenAt: null,
    activePtyProcess: null,
  };
}
