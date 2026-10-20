import { mkdirSync } from 'node:fs';

import { eq } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import { EditorContextService } from '../editor/index.js';
import {
  EditorContextRepository,
  NotApplicableEditorProvisioningLayer,
  readyEditorProvisioningLayer,
  editorContextServiceLayer,
  testInstallation,
  testSessionSocketDirectory,
} from '../editor/testing.js';
import { makeFakeFluidcastSessions, type FakeFluidcastSessions } from '../fluidcast/testing.js';
import {
  AgentSessionArtifacts,
  HarnessAdapterRegistry,
  HarnessLedgerObserver,
} from '../harnesses/index.js';
import { InternalEvents } from '../platform/events/index.js';
import { EntityLock } from '../platform/locks/index.js';
import { LoopbackPortProbe } from '../platform/net/index.js';
import { DataDirectory, RuntimeDatabase } from '../platform/persistence/index.js';
import { makeTestDataDirectory } from '../platform/persistence/testing.js';
import { ProjectRepository } from '../projects/index.js';
import { PtyForegroundState, PtyService } from '../pty-processes/index.js';
import { ptyProcesses } from '../pty-processes/tables.js';
import { fakeTerminateMany } from '../pty-processes/testing.js';
import { AgentSessionAttentionProjection } from './agent-sessions/attention.js';
import { AgentSessionInteraction } from './agent-sessions/interaction.js';
import { HarnessObservationTargetsLayerNoDeps } from './agent-sessions/observation-targets.js';
import { AgentSessionService } from './agent-sessions/service.js';
import { SurfaceService } from './index.js';
import { SessionLifecycle } from './sessions/lifecycle.js';
import type { AgentSessionRow } from './sessions/types.js';
import { SurfaceRepository } from './surfaces/repository.js';
import { agentSessions, surfacePanes, terminalSessions, worktreeSurfaces } from './tables.js';
import { TerminalSessionRepository } from './terminal-sessions/repository.js';
import { TerminalSessionService } from './terminal-sessions/service.js';

/** The durable session inventory over a real database, for other modules' live fixtures. */
export { listDurableSessionInventory } from './sessions/inventory.js';

export function insertWorktree(rootPath: string) {
  return Effect.gen(function* () {
    const projectRepository = yield* ProjectRepository;
    const { id: projectId } = yield* projectRepository.createProject({
      name: 'isagi',
      rootPath,
      kind: 'git',
    });
    yield* projectRepository.reconcileProjectWorktrees({
      projectId,
      discovered: [{ path: rootPath, branch: 'main', head: 'abcdef0' }],
    });
    const worktrees = yield* projectRepository.listWorktrees;
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
  readonly harness?: AgentSessionRow['harness'] | undefined;
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
          harness: input.harness ?? 'pi',
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
      return { terminalSessionId: session.id, ptyProcessId: process.id };
    });
  });
}

export function testLayer(
  dataRoot: string,
  options: {
    readonly agentService?: Partial<AgentSessionService['Service']> | undefined;
    readonly terminalService?: Partial<TerminalSessionService['Service']> | undefined;
    readonly ptyService?: Partial<PtyService['Service']> | undefined;
    /**
     * Whether the editor is provisioned. `ready` by default so placement tests
     * exercise the operation rather than its Class C guard; `unavailable` is for
     * the tests that assert the refusal and its absence of residue.
     */
    readonly editorProvisioning?: 'ready' | 'unavailable' | undefined;
    /**
     * Wrap the real editor service. Concurrency tests use this to insert a
     * suspension into the window the per-worktree lock exists to protect:
     * SQLite is synchronous here, so two forked opens would otherwise never
     * interleave and the assertion would hold with or without the lock.
     */
    readonly decorateEditorService?:
      | ((inner: EditorContextService['Service']) => EditorContextService['Service'])
      | undefined;
    /**
     * Use the *real* terminal session service over this harness's database,
     * wrapped. Race tests use it to suspend startup between creating a session
     * and binding it, and then read the durable row that really resulted.
     * Replaces `terminalService`.
     */
    readonly decorateTerminalService?:
      | ((inner: TerminalSessionService['Service']) => TerminalSessionService['Service'])
      | undefined;
    /**
     * Wrap the real surfaces repository. Race tests use it to hand the service
     * a stale read, standing in for a change that lands between the service's
     * read and its transaction — a window synchronous SQLite never opens here.
     */
    readonly decorateSurfaceRepository?:
      | ((inner: SurfaceRepository['Service']) => SurfaceRepository['Service'])
      | undefined;
    /** The Fluidcast sessions behind the agents' interaction; disabled by default. */
    readonly fluidcast?: FakeFluidcastSessions | undefined;
  } = {},
) {
  mkdirSync(testSessionSocketDirectory(dataRoot), { recursive: true });
  const dataDirectory = makeTestDataDirectory(dataRoot);

  const dataDirectoryLayer = Layer.succeed(DataDirectory, dataDirectory);
  const internalEventsLayer = InternalEvents.layer;
  const agentSessionArtifacts = AgentSessionArtifacts.layer.pipe(Layer.provide(dataDirectoryLayer));
  const database = RuntimeDatabase.layer.pipe(Layer.provide(dataDirectoryLayer));
  const fluidcast = (options.fluidcast ?? makeFakeFluidcastSessions({ availability: 'disabled' }))
    .layer;
  // One interaction for every consumer, as `AgentSessionInteraction.layer` is in the app.
  const interaction = AgentSessionInteraction.layerNoDeps.pipe(Layer.provide(fluidcast));
  const harnessRegistry = HarnessAdapterRegistry.layer.pipe(
    Layer.provide(dataDirectoryLayer),
    Layer.provide(agentSessionArtifacts),
  );
  const harnessLedgerObserver = HarnessLedgerObserver.layerNoDeps.pipe(
    Layer.provide(dataDirectoryLayer),
    Layer.provide(
      HarnessObservationTargetsLayerNoDeps.pipe(
        Layer.provide(database),
        Layer.provide(interaction),
      ),
    ),
    Layer.provide(agentSessionArtifacts),
    Layer.provide(internalEventsLayer),
  );
  const attentionProjection = AgentSessionAttentionProjection.layerNoDeps.pipe(
    Layer.provide(database),
    Layer.provide(agentSessionArtifacts),
    Layer.provide(PtyForegroundState.layer),
    Layer.provide(harnessLedgerObserver),
    Layer.provide(interaction),
  );
  const projectRepository = ProjectRepository.layer.pipe(Layer.provide(database));
  const agentService = Layer.effect(
    AgentSessionService,
    Effect.map(RuntimeDatabase, (db) =>
      recordingAgentSessions(db, fakeAgentSessionService(options.agentService)),
    ),
  ).pipe(Layer.provide(database));
  const ptyService = Layer.succeed(PtyService, fakePtyService(options.ptyService));
  const baseSurfaceRepository = SurfaceRepository.layerNoDeps.pipe(
    Layer.provide(database),
    Layer.provide(agentSessionArtifacts),
    Layer.provide(attentionProjection),
  );
  const decorateRepository = options.decorateSurfaceRepository;
  const surfaceRepository = decorateRepository
    ? Layer.effect(SurfaceRepository, Effect.map(SurfaceRepository, decorateRepository)).pipe(
        Layer.provide(baseSurfaceRepository),
      )
    : baseSurfaceRepository;
  // One lock value, shared by session lifecycle, the editor service, and the
  // placement path, exactly as the self-wired layers share `EntityLock.layer`. Two would make the
  // per-worktree serialization these tests assert vacuous.
  const entityLock = EntityLock.layer;
  const sessionLifecycle = SessionLifecycle.layerNoDeps.pipe(Layer.provide(entityLock));
  const decorateTerminal = options.decorateTerminalService;
  const terminalService = decorateTerminal
    ? Layer.effect(
        TerminalSessionService,
        Effect.map(TerminalSessionService, decorateTerminal),
      ).pipe(
        Layer.provide(
          TerminalSessionService.layerNoDeps.pipe(
            Layer.provide(TerminalSessionRepository.layer.pipe(Layer.provide(database))),
            Layer.provide(ptyService),
            Layer.provide(internalEventsLayer),
            Layer.provide(sessionLifecycle),
          ),
        ),
      )
    : Layer.effect(
        TerminalSessionService,
        Effect.map(RuntimeDatabase, (db) =>
          recordingTerminalSessions(db, fakeTerminalSessionService(options.terminalService)),
        ),
      ).pipe(Layer.provide(database));
  // The editor domain owns creating a context; the surfaces repository only
  // reads and places one. Tests need the former to exercise the latter.
  const editorRepository = EditorContextRepository.layer.pipe(Layer.provide(database));
  // The real service, over this harness's own already-bound dependencies. The
  // PTY double is the same value `SurfaceService.layerNoDeps` receives, so the two
  // services genuinely observe one process world; `editorServiceLayer` is
  // deliberately not reused here because it would construct a second database,
  // bus, lock, and PTY service.
  const baseEditorService = editorContextServiceLayer({
    database: editorRepository,
    workspace: projectRepository,
    pty: ptyService,
    provisioning:
      options.editorProvisioning === 'unavailable'
        ? NotApplicableEditorProvisioningLayer
        : readyEditorProvisioningLayer(testInstallation(dataRoot)),
    portProbe: LoopbackPortProbe.layer,
    entityLock,
    bus: internalEventsLayer,
  });
  const decorate = options.decorateEditorService;
  const editorService = decorate
    ? Layer.effect(EditorContextService, Effect.map(EditorContextService, decorate)).pipe(
        Layer.provide(baseEditorService),
      )
    : baseEditorService;
  const surfaceService = SurfaceService.layerNoDeps.pipe(
    Layer.provide(surfaceRepository),
    Layer.provide(agentService),
    Layer.provide(terminalService),
    Layer.provide(ptyService),
    Layer.provide(sessionLifecycle),
    Layer.provide(internalEventsLayer),
    Layer.provide(editorService),
    Layer.provide(entityLock),
    Layer.provide(interaction),
    Layer.provide(fluidcast),
    Layer.provide(harnessRegistry),
  );
  return Layer.mergeAll(
    interaction,
    database,
    editorRepository,
    editorService,
    entityLock,
    agentSessionArtifacts,
    attentionProjection,
    internalEventsLayer,
    projectRepository,
    surfaceRepository,
    surfaceService,
    sessionLifecycle,
    ptyService,
  );
}

/**
 * A fake's `startFresh` names an id; this makes the durable row for it exist.
 * Placement refuses a session with no row (the pane's `session_id` has no
 * foreign key, so the claim checks it), and tests keep choosing their own ids.
 */
function recordingAgentSessions(
  database: RuntimeDatabase['Service'],
  service: AgentSessionService['Service'],
): AgentSessionService['Service'] {
  return {
    ...service,
    startFresh: (input) =>
      service.startFresh(input).pipe(
        Effect.tap(({ agentSessionId }) =>
          database.use('test_record_agent_session', (db) => {
            const now = new Date().toISOString();
            db.insert(agentSessions)
              .values({
                id: agentSessionId,
                worktreeId: input.worktreeId,
                harness: input.harness,
                cwd: input.cwd,
                activePtyProcessId: null,
                createdAt: now,
                updatedAt: now,
                lastSeenAt: null,
              })
              .onConflictDoNothing()
              .run();
          }),
        ),
      ),
  };
}

function recordingTerminalSessions(
  database: RuntimeDatabase['Service'],
  service: TerminalSessionService['Service'],
): TerminalSessionService['Service'] {
  return {
    ...service,
    startFresh: (input) =>
      service.startFresh(input).pipe(
        Effect.tap(({ terminalSessionId }) =>
          database.use('test_record_terminal_session', (db) => {
            const now = new Date().toISOString();
            db.insert(terminalSessions)
              .values({
                id: terminalSessionId,
                worktreeId: input.worktreeId,
                cwd: input.cwd,
                shellCommand: 'bash',
                shellArgsJson: '[]',
                activePtyProcessId: null,
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoNothing()
              .run();
          }),
        ),
      ),
  };
}

function fakeAgentSessionService(
  overrides: Partial<AgentSessionService['Service']> = {},
): AgentSessionService['Service'] {
  return {
    startFresh: () => Effect.die('agent startFresh is not used by surface service tests'),
    get: () => Effect.die('agent get is not used by surface service tests'),
    ensureActivePtyProcess: () =>
      Effect.die('agent ensureActivePtyProcess is not used by surface service tests'),
    requireTerminalMode: () =>
      Effect.die('agent requireTerminalMode is not used by surface service tests'),
    withRunningTerminal: () =>
      Effect.die('agent withRunningTerminal is not used by surface service tests'),
    isControllerLive: () =>
      Effect.die('agent isControllerLive is not used by surface service tests'),
    stopUnlessPlaced: () =>
      Effect.die('agent stopUnlessPlaced is not used by surface service tests'),
    setInteractionMode: () =>
      Effect.die('agent setInteractionMode is not used by surface service tests'),
    // Deletes release every agent's controller; with no controllers in these tests it does nothing.
    releaseControllers: () => Effect.void,
    holdWorktreesForDeletion: () => Effect.void,
    holdProjectForDeletion: () => Effect.void,
    ...overrides,
  } satisfies AgentSessionService['Service'];
}

function fakeTerminalSessionService(
  overrides: Partial<TerminalSessionService['Service']> = {},
): TerminalSessionService['Service'] {
  return {
    startFresh: () => Effect.die('terminal startFresh is not used by surface service tests'),
    get: () => Effect.die('terminal get is not used by surface service tests'),
    ensureActivePtyProcess: () =>
      Effect.die('terminal ensureActivePtyProcess is not used by surface service tests'),
    activePtyProcessId: () =>
      Effect.die('terminal activePtyProcessId is not used by surface service tests'),
    ...overrides,
  } satisfies TerminalSessionService['Service'];
}

function fakePtyService(overrides: Partial<PtyService['Service']> = {}): PtyService['Service'] {
  const terminate: PtyService['Service']['terminate'] =
    overrides.terminate ?? (() => Effect.succeed('terminated_live' as const));
  return {
    allocateLaunch: () => Effect.die('pty allocateLaunch is not used'),
    readLogTail: () => Effect.die('readLogTail is not used'),
    launch: () => Effect.die('pty launch is not used by surface service tests'),
    getAttachmentPlan: () =>
      Effect.die('pty getAttachmentPlan is not used by surface service tests'),
    attach: () => Effect.die('pty attach is not used by surface service tests'),
    replay: () => Effect.die('pty replay is not used by surface service tests'),
    write: () => Effect.die('pty write is not used by surface service tests'),
    writeInput: () => Effect.die('pty writeInput is not used by surface service tests'),
    resize: () => Effect.die('pty resize is not used by surface service tests'),
    kill: () => Effect.die('pty kill is not used by surface service tests'),
    terminate,
    terminateMany: fakeTerminateMany(terminate),
    findProcess: () => Effect.die('pty findProcess is not used by surface service tests'),
    pin: () => Effect.void,
    unpin: () => Effect.void,
    cleanupProcess: () => Effect.die('pty cleanupProcess is not used'),
    isPinned: () => Effect.succeed(false),
    ...overrides,
  } satisfies PtyService['Service'];
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

// Internals and builders other modules' tests use; never imported by production code.
export { AgentSessionError, notInTerminalMode } from './agent-sessions/service.js';
export type { StopUnlessPlacedOutcome } from './agent-sessions/service.js';
export { SurfaceRepository } from './surfaces/repository.js';
export { TerminalSessionService } from './terminal-sessions/service.js';
export { TerminalSessionError } from './terminal-sessions/service.js';
export {
  captureStartupLogs,
  paneBoundRestoreLayer,
  realRestoreLayer,
  realSessionCreationLayer,
  sessionCreationLayerFor,
  sessionDataLayer,
  sessionWorldLayers,
} from './tests/restore-support.js';
export type { HarnessLaunchRecord } from './tests/restore-support.js';
