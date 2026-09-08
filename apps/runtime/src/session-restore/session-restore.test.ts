import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import {
  AgentSessionError,
  AgentSessionArtifacts,
  AgentSessionService,
  type AgentSessionServiceShape,
} from '../agent-sessions/index.js';
import { createFixtureWorkspace } from '../git/tests/fixtures.js';
import { HarnessLaunchBlocked } from '../harness-control-plane/index.js';
import { DatabaseError, RuntimeDatabase } from '../persistence/index.js';
import {
  agentSessions,
  projects,
  ptyProcesses,
  surfacePanes,
  terminalSessions,
  worktrees,
  worktreeSurfaces,
} from '../persistence/schema.js';
import type { LaunchPtyProcessInput } from '../pty-processes/types.js';
import { SurfaceService } from '../surfaces/index.js';
import {
  SurfaceRepository,
  type SurfaceRepositoryService,
} from '../surfaces/surfaces.repository.js';
import type { PaneSessionBinding } from '../surfaces/types.js';
import {
  TerminalSessionService,
  TerminalSessionError,
  type TerminalSessionServiceShape,
} from '../terminal-sessions/index.js';
import { liveWorkspaceLayer } from '../workspace/tests/live-workspace-support.js';
import { WorkspaceRepository } from '../workspace/workspace.repository.js';
import { WorkspaceService } from '../workspace/workspace.service.js';
import { StartupSessionRestoreLayer } from './session-restore.js';
import {
  captureStartupLogs,
  type HarnessLaunchRecord,
  realRestoreLayer,
  realSessionCreationLayer,
  sessionDataLayer,
} from './test-support.js';

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
  const ptyLaunches: LaunchPtyProcessInput[] = [];
  const harnessLaunches: HarnessLaunchRecord[] = [];
  // This suite asserts specific process identifiers, so it pins them rather
  // than taking the shared counter. `pi` and `bash` are the two commands its
  // fixture launches.
  const world = {
    ptyLaunches,
    harnessLaunches,
    allocatePtyProcessId: (input: LaunchPtyProcessInput) => (input.command === 'pi' ? 101 : 201),
  };
  try {
    await Effect.runPromise(
      seedRestoreIntegrationRows.pipe(Effect.provide(sessionDataLayer(dataRoot))),
    );

    await captureStartupLogs(() =>
      Effect.runPromise(
        Effect.void.pipe(Effect.provide(realRestoreLayer(dataRoot, world)), Effect.scoped),
      ),
    );

    const state = await Effect.runPromise(
      readRestoreIntegrationState.pipe(Effect.provide(sessionDataLayer(dataRoot))),
    );

    assert.deepEqual(
      harnessLaunches.map((launch) => launch.agentSessionId),
      [10],
    );
    assert.equal(harnessLaunches[0]?.latest, null);
    assert.deepEqual(ptyLaunches.map((launch) => launch.command).sort(), ['bash', 'pi']);
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
    listEditorContextsForPanes: () => Effect.die('listEditorContextsForPanes is not used'),
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

/**
 * The same question as the suite above, asked of a project that has no Git to
 * fall back on, and asked through the services that actually own the work.
 *
 * Every row here is produced by the API that owns it: the project by
 * `registerProject`, the surfaces and panes by `SurfaceService`, the sessions by
 * `createPaneSession`. That matters for one specific reason — `createPaneSession`
 * resolves a session's `cwd` from `findWorktreePath(worktreeId)`. Seeding those
 * rows by hand would write the folder path the test already knew and prove
 * nothing about it reaching the session. Here the path has to travel.
 *
 * The PTY backend and the harness adapter are fake. Nothing below establishes
 * that a real shell ran, that a real harness emitted the recorded identity, or
 * that a real harness would resume from it.
 */
test('a folder project keeps its sessions, paths, and resume identity across a restart, with new process incarnations', async () => {
  const fixtures = createFixtureWorkspace('folder-session-continuity');
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-folder-session-continuity-'));
  const projectPath = fixtures.directory('notes');
  writeFileSync(join(projectPath, 'notes.md'), '# notes\n');

  // Deterministic, and deliberately not derivable from anything the runtime
  // could reconstruct: if it reaches the adapter, it was stored and read back.
  const harnessSessionId = 'harness-session-6f2ac91b';

  try {
    // ── Stage 1: register the folder ────────────────────────────────────────
    const registered = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        const repository = yield* WorkspaceRepository;
        const added = yield* service.registerProject({ path: projectPath });
        const worktree = (yield* repository.listWorktrees).find(
          (row) => row.projectId === added.projectId,
        );
        if (!worktree) throw new Error('Expected the folder project to own an environment.');
        return { projectId: added.projectId, worktreeId: worktree.id };
      }).pipe(Effect.provide(liveWorkspaceLayer(dataRoot, {}))),
    );

    // ── Stage 2: create surfaces, panes, and pane-bound sessions ────────────
    const creationWorld = {
      ptyLaunches: [] as LaunchPtyProcessInput[],
      harnessLaunches: [] as HarnessLaunchRecord[],
    };
    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        const agents = yield* AgentSessionService;
        const terminals = yield* TerminalSessionService;
        const artifacts = yield* AgentSessionArtifacts;

        const agentSurface = yield* surfaces.createSinglePaneSurface({
          worktreeId: registered.worktreeId,
          titleBase: 'Agent',
        });
        const agentBound = yield* surfaces.createPaneSession({
          worktreeId: registered.worktreeId,
          create: { kind: 'agent_session', paneId: agentSurface.paneId, harness: 'pi' },
        });
        const terminalSurface = yield* surfaces.createSinglePaneSurface({
          worktreeId: registered.worktreeId,
          titleBase: 'Terminal',
        });
        const terminalBound = yield* surfaces.createPaneSession({
          worktreeId: registered.worktreeId,
          create: { kind: 'terminal_session', paneId: terminalSurface.paneId },
        });
        if (agentBound.session.kind !== 'agent_session') throw new Error('Expected an agent pane.');
        if (terminalBound.session.kind !== 'terminal_session')
          throw new Error('Expected a terminal pane.');
        const agentSessionId = agentBound.session.agentSessionId;
        const terminalSessionId = terminalBound.session.terminalSessionId;

        // The processes running before the shutdown.
        const agentPtyProcessId = yield* agents.ensureActivePtyProcess(agentSessionId);
        const terminalPtyProcessId = yield* terminals.ensureActivePtyProcess(terminalSessionId);

        // The identity a harness would have been observed emitting, written
        // through the API that owns it rather than into the file behind it.
        yield* artifacts.writeHarnessSessionId({ agentSessionId, harnessSessionId });

        return {
          agentSurfaceId: agentSurface.surfaceId,
          agentPaneId: agentSurface.paneId,
          terminalSurfaceId: terminalSurface.surfaceId,
          terminalPaneId: terminalSurface.paneId,
          agentSessionId,
          terminalSessionId,
          agentPtyProcessId,
          terminalPtyProcessId,
        };
      }).pipe(Effect.provide(realSessionCreationLayer(dataRoot, creationWorld))),
    );

    // The path travelled from the registered folder into both session rows.
    assert.deepEqual(
      creationWorld.ptyLaunches.map((launch) => launch.cwd),
      [projectPath, projectPath],
    );

    // ── Stage 3: reopen and read what persisted ─────────────────────────────
    const before = await Effect.runPromise(
      readFolderSessionState(created.agentSessionId, created.terminalSessionId).pipe(
        Effect.provide(sessionDataLayer(dataRoot)),
      ),
    );
    assert.equal(before.agent?.cwd, projectPath);
    assert.equal(before.terminal?.cwd, projectPath);
    assert.equal(before.agent?.activePtyProcessId, created.agentPtyProcessId);
    assert.equal(before.terminal?.activePtyProcessId, created.terminalPtyProcessId);
    assert.equal(before.harnessSessionId, harnessSessionId);

    // ── Stage 4: restart ────────────────────────────────────────────────────
    const restartWorld = {
      ptyLaunches: [] as LaunchPtyProcessInput[],
      harnessLaunches: [] as HarnessLaunchRecord[],
    };
    const restartLogs = await captureStartupLogs(() =>
      Effect.runPromise(
        Effect.void.pipe(Effect.provide(realRestoreLayer(dataRoot, restartWorld)), Effect.scoped),
      ),
    );

    // Restore's own report, asserted before anything downstream of it. Restore
    // isolates a failing pane and carries on, so without this a broken fixture
    // reads as "the process was not replaced" — which is also what a genuine
    // continuity regression looks like. The two are only distinguishable here.
    assert.deepEqual(restartLogs.warn, []);
    assert.deepEqual(restartLogs.info.at(-1)?.[1], {
      attempted: 2,
      relaunched: 2,
      reused: 0,
      skippedUnrecoverable: 0,
      failed: 0,
    });

    // ── Stage 5: reopen again and compare ───────────────────────────────────
    const after = await Effect.runPromise(
      readFolderSessionState(created.agentSessionId, created.terminalSessionId).pipe(
        Effect.provide(sessionDataLayer(dataRoot)),
      ),
    );

    // Durable identity is unchanged: same sessions, same environment, same
    // panes, same folder cwd.
    assert.equal(after.agent?.id, created.agentSessionId);
    assert.equal(after.terminal?.id, created.terminalSessionId);
    assert.equal(after.agent?.worktreeId, registered.worktreeId);
    assert.equal(after.terminal?.worktreeId, registered.worktreeId);
    assert.equal(after.agent?.cwd, projectPath);
    assert.equal(after.terminal?.cwd, projectPath);
    // Each pane is asserted with the surface it hangs off, so a pane that
    // survived while its surface association moved would fail here rather than
    // read as intact.
    assert.deepEqual(after.panes, [
      {
        paneId: created.agentPaneId,
        surfaceId: created.agentSurfaceId,
        sessionKind: 'agent_session',
        sessionId: created.agentSessionId,
      },
      {
        paneId: created.terminalPaneId,
        surfaceId: created.terminalSurfaceId,
        sessionKind: 'terminal_session',
        sessionId: created.terminalSessionId,
      },
    ]);
    // And the surfaces themselves are the two that were created, still on the
    // folder's environment.
    assert.deepEqual(after.surfaceIds, [
      { id: created.agentSurfaceId, worktreeId: registered.worktreeId },
      { id: created.terminalSurfaceId, worktreeId: registered.worktreeId },
    ]);
    assert.equal(after.harnessSessionId, harnessSessionId);

    // The processes are new. Asserted as "different, and backed by a row that
    // exists" rather than against a literal identifier, because which number
    // the backend hands out is not a durable fact.
    assert.notEqual(after.agent?.activePtyProcessId, created.agentPtyProcessId);
    assert.notEqual(after.terminal?.activePtyProcessId, created.terminalPtyProcessId);
    assert.equal(after.agentProcess?.status, 'running');
    assert.equal(after.agentProcess?.cwd, projectPath);
    assert.equal(after.terminalProcess?.status, 'running');
    assert.equal(after.terminalProcess?.cwd, projectPath);

    // Restore launched exactly these two, in the folder.
    assert.equal(restartWorld.ptyLaunches.length, 2);
    assert.deepEqual(
      restartWorld.ptyLaunches.map((launch) => launch.cwd),
      [projectPath, projectPath],
    );

    // The stored identity reached the adapter and its resume arguments. This is
    // propagation of an observation Isagi stored — not evidence that a harness
    // emitted it, nor that resuming from it would succeed.
    assert.deepEqual(restartWorld.harnessLaunches, [
      {
        agentSessionId: created.agentSessionId,
        latest: harnessSessionId,
        cwd: projectPath,
        args: ['--session', harnessSessionId],
      },
    ]);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    fixtures.cleanup();
  }
});

/** Durable session facts, read outside any service, in their own connection. */
function readFolderSessionState(agentSessionId: number, terminalSessionId: number) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const artifacts = yield* AgentSessionArtifacts;
    const metadata = yield* artifacts.readMetadata(agentSessionId);
    const rows = yield* database.use('test_read_folder_session_state', (db) => {
      const agent = db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, agentSessionId))
        .get();
      const terminal = db
        .select()
        .from(terminalSessions)
        .where(eq(terminalSessions.id, terminalSessionId))
        .get();
      const processFor = (id: number | null) =>
        id === null
          ? null
          : (db.select().from(ptyProcesses).where(eq(ptyProcesses.id, id)).get() ?? null);
      return {
        agent: agent ?? null,
        terminal: terminal ?? null,
        agentProcess: processFor(agent?.activePtyProcessId ?? null),
        terminalProcess: processFor(terminal?.activePtyProcessId ?? null),
        panes: db
          .select({
            paneId: surfacePanes.id,
            surfaceId: surfacePanes.surfaceId,
            sessionKind: surfacePanes.sessionKind,
            sessionId: surfacePanes.sessionId,
          })
          .from(surfacePanes)
          .orderBy(surfacePanes.id)
          .all(),
        surfaceIds: db
          .select({ id: worktreeSurfaces.id, worktreeId: worktreeSurfaces.worktreeId })
          .from(worktreeSurfaces)
          .orderBy(worktreeSurfaces.id)
          .all(),
      };
    });
    return {
      ...rows,
      harnessSessionId: metadata.status === 'valid' ? metadata.metadata.harnessSessionId : null,
    };
  });
}
