import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import {
  AgentSessionError,
  AgentSessionArtifacts,
  AgentSessionArtifactsLive,
  AgentSessionRepositoryLive,
  AgentSessionService,
  AgentSessionServiceLive,
  type AgentSessionServiceShape,
  HarnessAdapterRegistry,
  type HarnessAdapterRegistryService,
} from '../agent-sessions/index.js';
import { HarnessLaunchBlocked } from '../harness-control-plane/index.js';
import { AllowAllHarnessControlPlaneLayer } from '../harness-control-plane/test-support.js';
import {
  DataDirectory,
  DatabaseError,
  RuntimeDatabase,
  RuntimeDatabaseLive,
  type RuntimeDatabaseService,
} from '../persistence/index.js';
import {
  agentSessions,
  projects,
  ptyProcesses,
  surfacePanes,
  terminalSessions,
  worktrees,
  worktreeSurfaces,
} from '../persistence/schema.js';
import { makeTestDataDirectory } from '../persistence/test-support.js';
import { PtyService, type PtyServiceShape } from '../pty-processes/index.js';
import type { LaunchPtyProcessInput } from '../pty-processes/types.js';
import { InternalRuntimeEventBusLive } from '../runtime-events/index.js';
import { SessionLifecycleLive } from '../session-lifecycle/index.js';
import {
  SurfaceRepository,
  SurfaceRepositoryLive,
  type SurfaceRepositoryService,
} from '../surfaces/surfaces.repository.js';
import type { PaneSessionBinding } from '../surfaces/types.js';
import {
  TerminalSessionService,
  TerminalSessionError,
  TerminalSessionRepositoryLive,
  TerminalSessionServiceLive,
  type TerminalSessionServiceShape,
} from '../terminal-sessions/index.js';
import { StartupSessionRestoreLayer } from './session-restore.js';

test('startup session restore ensures every pane-bound session and isolates failures', async () => {
  const calls: string[] = [];
  const logs = await captureStartupLogs(() =>
    Effect.runPromise(
      Effect.void.pipe(
        Effect.provide(
          restoreLayer({
            bindings: [
              agentBinding({ paneId: 1, sessionId: 10, activePtyProcessId: 20 }),
              terminalBinding({ paneId: 2, sessionId: 11, activePtyProcessId: 21 }),
              agentBinding({ paneId: 3, sessionId: 12, activePtyProcessId: 22 }),
              terminalBinding({ paneId: 4, sessionId: 13, activePtyProcessId: 23 }),
              agentBinding({ paneId: 5, sessionId: 14, activePtyProcessId: 24 }),
            ],
            agentService: {
              ensureActivePtyProcess: (agentSessionId, options) =>
                Effect.gen(function* () {
                  calls.push(`agent:${agentSessionId}:${options?.replaceEphemeralProcess}`);
                  if (agentSessionId === 12) {
                    return yield* Effect.fail(
                      new AgentSessionError('harness_metadata_missing', 'metadata missing'),
                    );
                  }
                  if (agentSessionId === 14) {
                    return yield* Effect.fail(
                      new HarnessLaunchBlocked({
                        harness: 'pi',
                        reason: 'harness_disabled',
                        diagnostic: null,
                      }),
                    );
                  }
                  return 30;
                }),
            },
            terminalService: {
              ensureActivePtyProcess: (terminalSessionId, options) =>
                Effect.gen(function* () {
                  calls.push(`terminal:${terminalSessionId}:${options?.replaceEphemeralProcess}`);
                  if (terminalSessionId === 13) {
                    return yield* Effect.fail(
                      new TerminalSessionError('session_not_found', 'session missing'),
                    );
                  }
                  return 21;
                }),
            },
          }),
        ),
        Effect.scoped,
      ),
    ),
  );

  assert.deepEqual(calls.sort(), [
    'agent:10:true',
    'agent:12:true',
    'agent:14:true',
    'terminal:11:true',
    'terminal:13:true',
  ]);
  assert.equal(logs.warn.length, 3);
  assert.deepEqual(
    logs.warn.find(
      (entry) => (entry[1] as { readonly paneId?: number } | undefined)?.paneId === 5,
    )?.[1],
    {
      paneId: 5,
      sessionKind: 'agent_session',
      sessionId: 14,
      activePtyProcessId: 24,
      outcome: 'failed',
      errorTag: 'HarnessLaunchBlocked',
      errorCode: null,
      harness: 'pi',
      errorReason: 'harness_disabled',
      errorDiagnostic: null,
      message: 'Harness pi launch blocked: harness_disabled.',
    },
  );
  assert.deepEqual(logs.info.at(-1)?.[1], {
    attempted: 5,
    relaunched: 1,
    reused: 1,
    skippedUnrecoverable: 1,
    failed: 2,
  });
});

test('startup session restore does not fail boot when binding discovery fails', async () => {
  const logs = await captureStartupLogs(() =>
    Effect.runPromise(
      Effect.void.pipe(
        Effect.provide(
          restoreLayer({
            bindings: new DatabaseError({
              operation: 'list_pane_session_bindings',
              cause: new Error('db down'),
            }),
          }),
        ),
        Effect.scoped,
      ),
    ),
  );

  assert.equal(logs.warn.length, 1);
  assert.match(String(logs.warn[0]?.[0]), /binding discovery failed/);
});

test('startup session restore uses real services to restore pane-bound sessions only', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-startup-session-restore-'));
  const launches: LaunchPtyProcessInput[] = [];
  const harnessLaunches: Array<{
    readonly agentSessionId: number;
    readonly latest: string | null;
  }> = [];
  try {
    await Effect.runPromise(seedRestoreIntegrationRows.pipe(Effect.provide(seedLayer(dataRoot))));

    await captureStartupLogs(() =>
      Effect.runPromise(
        Effect.void.pipe(
          Effect.provide(realRestoreLayer(dataRoot, launches, harnessLaunches)),
          Effect.scoped,
        ),
      ),
    );

    const state = await Effect.runPromise(
      readRestoreIntegrationState.pipe(Effect.provide(seedLayer(dataRoot))),
    );

    assert.deepEqual(
      harnessLaunches.map((launch) => launch.agentSessionId),
      [10],
    );
    assert.equal(harnessLaunches[0]?.latest, null);
    assert.deepEqual(launches.map((launch) => launch.command).sort(), ['bash', 'pi']);
    assert.equal(state.restorableAgentActivePtyProcessId, 101);
    assert.equal(state.restorableTerminalActivePtyProcessId, 201);
    assert.equal(state.missingMetadataAgentActivePtyProcessId, 42);
    assert.equal(state.orphanAgentActivePtyProcessId, 43);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

function restoreLayer(input: {
  readonly bindings: readonly PaneSessionBinding[] | DatabaseError;
  readonly agentService?: Partial<AgentSessionServiceShape> | undefined;
  readonly terminalService?: Partial<TerminalSessionServiceShape> | undefined;
}) {
  return StartupSessionRestoreLayer.pipe(
    Layer.provide(Layer.succeed(SurfaceRepository, fakeSurfaceRepository(input.bindings))),
    Layer.provide(Layer.succeed(AgentSessionService, fakeAgentService(input.agentService))),
    Layer.provide(
      Layer.succeed(TerminalSessionService, fakeTerminalService(input.terminalService)),
    ),
  );
}

function realRestoreLayer(
  dataRoot: string,
  launches: LaunchPtyProcessInput[],
  harnessLaunches: Array<{ readonly agentSessionId: number; readonly latest: string | null }>,
) {
  const directory = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const databaseLayer = RuntimeDatabaseLive.pipe(Layer.provide(directory));
  const artifacts = AgentSessionArtifactsLive.pipe(Layer.provide(directory));
  const surfaceRepository = SurfaceRepositoryLive.pipe(
    Layer.provide(databaseLayer),
    Layer.provide(artifacts),
  );
  const agentRepository = AgentSessionRepositoryLive.pipe(
    Layer.provide(databaseLayer),
    Layer.provide(artifacts),
  );
  const terminalRepository = TerminalSessionRepositoryLive.pipe(Layer.provide(databaseLayer));
  const pty = Layer.effect(
    PtyService,
    Effect.map(RuntimeDatabase, (database) => fakeRealRestorePtyService(database, launches)),
  ).pipe(Layer.provide(databaseLayer));
  const harnessRegistry = Layer.succeed(
    HarnessAdapterRegistry,
    fakeHarnessRegistry(harnessLaunches),
  );
  const agentService = AgentSessionServiceLive.pipe(
    Layer.provide(AllowAllHarnessControlPlaneLayer),
    Layer.provide(agentRepository),
    Layer.provide(pty),
    Layer.provide(harnessRegistry),
    Layer.provide(SessionLifecycleLive),
    Layer.provide(InternalRuntimeEventBusLive),
  );
  const terminalService = TerminalSessionServiceLive.pipe(
    Layer.provide(terminalRepository),
    Layer.provide(pty),
    Layer.provide(SessionLifecycleLive),
    Layer.provide(InternalRuntimeEventBusLive),
  );
  return StartupSessionRestoreLayer.pipe(
    Layer.provide(surfaceRepository),
    Layer.provide(agentService),
    Layer.provide(terminalService),
  );
}

const seedRestoreIntegrationRows = Effect.gen(function* () {
  const database = yield* RuntimeDatabase;
  const artifacts = yield* AgentSessionArtifacts;
  yield* database.use('test_seed_startup_restore_rows', (db) => {
    const now = '2026-07-08T00:00:00.000Z';
    db.insert(projects)
      .values({
        id: 1,
        name: 'Isagi',
        rootPath: '/repo/isagi',
        status: 'present',
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        missingReason: null,
      })
      .run();
    db.insert(worktrees)
      .values({
        id: 1,
        projectId: 1,
        path: '/repo/isagi',
        branch: 'main',
        head: 'abcdef0',
        createdAt: now,
        updatedAt: now,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .run();
    db.insert(worktreeSurfaces)
      .values({
        id: 1,
        worktreeId: 1,
        title: 'Restore',
        layoutJson: JSON.stringify({
          kind: 'leaf',
          nodeId: 'pane-1',
          paneId: 1,
          collapsed: false,
        }),
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    for (const processId of [41, 42, 43, 51]) {
      const runningAtPreviousShutdown = processId === 41 || processId === 51;
      db.insert(ptyProcesses)
        .values({
          id: processId,
          backend: 'node_pty',
          backendRefJson: JSON.stringify({
            schemaVersion: 1,
            backend: 'node_pty',
            ptyProcessId: processId,
            pid: null,
          }),
          command: processId === 51 ? 'bash' : 'pi',
          argsJson: JSON.stringify([]),
          cwd: '/repo/isagi',
          status: runningAtPreviousShutdown ? 'running' : 'failed',
          statusReason: runningAtPreviousShutdown ? null : 'runtime_ephemeral_lost',
          exitCode: null,
          signal: null,
          logMode: 'none',
          logPath: null,
          createdAt: now,
          updatedAt: now,
          exitedAt: runningAtPreviousShutdown ? null : now,
          lastSeenAt: runningAtPreviousShutdown ? now : null,
        })
        .run();
    }
    db.insert(agentSessions)
      .values([
        {
          id: 10,
          worktreeId: 1,
          harness: 'pi',
          cwd: '/repo/isagi',
          activePtyProcessId: 41,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
        },
        {
          id: 11,
          worktreeId: 1,
          harness: 'pi',
          cwd: '/repo/isagi',
          activePtyProcessId: 42,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
        },
        {
          id: 12,
          worktreeId: 1,
          harness: 'pi',
          cwd: '/repo/isagi',
          activePtyProcessId: 43,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
        },
      ])
      .run();
    db.insert(terminalSessions)
      .values({
        id: 20,
        worktreeId: 1,
        cwd: '/repo/isagi',
        shellCommand: 'bash',
        shellArgsJson: JSON.stringify([]),
        activePtyProcessId: 51,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(surfacePanes)
      .values([
        {
          id: 1,
          surfaceId: 1,
          title: 'Agent',
          sortOrder: 0,
          sessionKind: 'agent_session',
          sessionId: 10,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 2,
          surfaceId: 1,
          title: 'Terminal',
          sortOrder: 1,
          sessionKind: 'terminal_session',
          sessionId: 20,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 3,
          surfaceId: 1,
          title: 'Missing metadata',
          sortOrder: 2,
          sessionKind: 'agent_session',
          sessionId: 11,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
  });
  yield* artifacts.initializeMetadata(10);
  yield* artifacts.initializeMetadata(12);
});

const readRestoreIntegrationState = Effect.gen(function* () {
  const database = yield* RuntimeDatabase;
  return yield* database.use('test_read_startup_restore_rows', (db) => {
    const agentRows = db
      .select({ id: agentSessions.id, activePtyProcessId: agentSessions.activePtyProcessId })
      .from(agentSessions)
      .all();
    const terminal = db
      .select({ activePtyProcessId: terminalSessions.activePtyProcessId })
      .from(terminalSessions)
      .where(eq(terminalSessions.id, 20))
      .get();
    const activeAgentById = new Map(
      agentRows.map((row) => [row.id, row.activePtyProcessId] as const),
    );
    return {
      restorableAgentActivePtyProcessId: activeAgentById.get(10) ?? null,
      missingMetadataAgentActivePtyProcessId: activeAgentById.get(11) ?? null,
      orphanAgentActivePtyProcessId: activeAgentById.get(12) ?? null,
      restorableTerminalActivePtyProcessId: terminal?.activePtyProcessId ?? null,
    };
  });
});

function seedLayer(dataRoot: string) {
  const directory = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabaseLive.pipe(Layer.provide(directory));
  const artifacts = AgentSessionArtifactsLive.pipe(Layer.provide(directory));
  return Layer.mergeAll(database, artifacts);
}

function fakeHarnessRegistry(
  launches: Array<{ readonly agentSessionId: number; readonly latest: string | null }>,
): HarnessAdapterRegistryService {
  return {
    buildLaunch: (input) =>
      Effect.sync(() => {
        launches.push({
          agentSessionId: input.agentSessionId,
          latest: input.latestHarnessSessionId,
        });
        return {
          command: 'pi',
          args: input.latestHarnessSessionId ? ['--session', input.latestHarnessSessionId] : [],
          cwd: input.cwd,
        };
      }),
    buildHeadlessLaunch: () => Effect.die('headless launch is not used'),
  } satisfies HarnessAdapterRegistryService;
}

function fakeRealRestorePtyService(
  database: RuntimeDatabaseService,
  launches: LaunchPtyProcessInput[],
): PtyServiceShape {
  return {
    allocateLaunch: () => Effect.die('pty allocateLaunch is not used'),
    launch: (input) =>
      Effect.gen(function* () {
        launches.push(input);
        const ptyProcessId = input.command === 'pi' ? 101 : 201;
        const now = '2026-07-08T00:00:01.000Z';
        yield* database.use('test_insert_launched_pty_process', (db) => {
          db.insert(ptyProcesses)
            .values({
              id: ptyProcessId,
              backend: 'node_pty',
              backendRefJson: JSON.stringify({
                schemaVersion: 1,
                backend: 'node_pty',
                ptyProcessId,
                pid: null,
              }),
              command: input.command,
              argsJson: JSON.stringify(input.args),
              cwd: input.cwd,
              status: 'running',
              statusReason: null,
              exitCode: null,
              signal: null,
              logMode: 'none',
              logPath: null,
              createdAt: now,
              updatedAt: now,
              exitedAt: null,
              lastSeenAt: now,
            })
            .run();
        });
        return {
          ptyProcessId,
          command: input.command,
          args: input.args,
          cwd: input.cwd,
          logPath: null,
        };
      }),
    getAttachmentPlan: () => Effect.die('getAttachmentPlan is not used'),
    attach: () => Effect.die('attach is not used'),
    replay: () => Effect.die('replay is not used'),
    write: () => Effect.die('write is not used'),
    writeInput: () => Effect.die('writeInput is not used'),
    resize: () => Effect.die('resize is not used'),
    kill: () => Effect.die('kill is not used'),
    terminate: () => Effect.succeed('terminated_live' as const),
    pin: () => Effect.void,
    unpin: () => Effect.void,
    isPinned: () => Effect.succeed(false),
  } satisfies PtyServiceShape;
}

function fakeSurfaceRepository(
  bindings: readonly PaneSessionBinding[] | DatabaseError,
): SurfaceRepositoryService {
  return {
    listPaneSessionBindings:
      bindings instanceof DatabaseError ? Effect.fail(bindings) : Effect.succeed([...bindings]),
    worktreeExists: () => Effect.die('worktreeExists is not used'),
    findSurface: () => Effect.die('findSurface is not used'),
    findPane: () => Effect.die('findPane is not used'),
    findWorktreePath: () => Effect.die('findWorktreePath is not used'),
    findEnvironmentFocus: () => Effect.die('findEnvironmentFocus is not used'),
    listWorkspaceSurfaceMetadata: Effect.die('listWorkspaceSurfaceMetadata is not used'),
    listEnvironmentFocusStates: Effect.die('listEnvironmentFocusStates is not used'),
    listPanesForSurface: () => Effect.die('listPanesForSurface is not used'),
    listAgentSessionsForPanes: () => Effect.die('listAgentSessionsForPanes is not used'),
    listTerminalSessionsForPanes: () => Effect.die('listTerminalSessionsForPanes is not used'),
    findPaneForSession: () => Effect.die('findPaneForSession is not used'),
    findSurfaceDeleteTarget: () => Effect.die('findSurfaceDeleteTarget is not used'),
    renameSurface: () => Effect.die('renameSurface is not used'),
    deleteSurface: () => Effect.die('deleteSurface is not used'),
    deleteSurfacePane: () => Effect.die('deleteSurfacePane is not used'),
    createSinglePaneSurface: () => Effect.die('createSinglePaneSurface is not used'),
    splitSurfacePane: () => Effect.die('splitSurfacePane is not used'),
    setSurfaceLayout: () => Effect.die('setSurfaceLayout is not used'),
    setPaneSession: () => Effect.die('setPaneSession is not used'),
    claimPaneSession: () => Effect.die('claimPaneSession is not used'),
    setEnvironmentFocus: () => Effect.die('setEnvironmentFocus is not used'),
    moveSurfaceOrder: () => Effect.die('moveSurfaceOrder is not used'),
  } satisfies SurfaceRepositoryService;
}

function fakeAgentService(
  overrides: Partial<AgentSessionServiceShape> = {},
): AgentSessionServiceShape {
  return {
    startFresh: () => Effect.die('agent startFresh is not used'),
    get: () => Effect.die('agent get is not used'),
    ensureActivePtyProcess: () => Effect.die('agent ensureActivePtyProcess is not configured'),
    activePtyProcessId: () => Effect.die('agent activePtyProcessId is not used'),
    ...overrides,
  } satisfies AgentSessionServiceShape;
}

function fakeTerminalService(
  overrides: Partial<TerminalSessionServiceShape> = {},
): TerminalSessionServiceShape {
  return {
    startFresh: () => Effect.die('terminal startFresh is not used'),
    get: () => Effect.die('terminal get is not used'),
    ensureActivePtyProcess: () => Effect.die('terminal ensureActivePtyProcess is not configured'),
    activePtyProcessId: () => Effect.die('terminal activePtyProcessId is not used'),
    ...overrides,
  } satisfies TerminalSessionServiceShape;
}

function agentBinding(input: {
  readonly paneId: number;
  readonly sessionId: number;
  readonly activePtyProcessId: number | null;
}): PaneSessionBinding {
  return { ...input, sessionKind: 'agent_session' };
}

function terminalBinding(input: {
  readonly paneId: number;
  readonly sessionId: number;
  readonly activePtyProcessId: number | null;
}): PaneSessionBinding {
  return { ...input, sessionKind: 'terminal_session' };
}

async function captureStartupLogs(run: () => Promise<void>) {
  const info = console.info;
  const warn = console.warn;
  const captured = {
    info: [] as unknown[][],
    warn: [] as unknown[][],
  };
  console.info = (...args: unknown[]) => captured.info.push(args);
  console.warn = (...args: unknown[]) => captured.warn.push(args);
  try {
    await run();
    return captured;
  } finally {
    console.info = info;
    console.warn = warn;
  }
}
