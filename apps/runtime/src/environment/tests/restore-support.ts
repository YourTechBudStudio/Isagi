import { eq } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import { EditorContextService } from '../../editor/index.js';
import { AgentSessionArtifacts, HarnessAdapterRegistry } from '../../harnesses/index.js';
import { AllowAllHarnessControlPlaneLayer } from '../../harnesses/testing.js';
import { InternalEvents } from '../../platform/events/index.js';
import { EntityLock } from '../../platform/locks/index.js';
import { DataDirectory, RuntimeDatabase } from '../../platform/persistence/index.js';
import { makeTestDataDirectory } from '../../platform/persistence/testing.js';
import { PtyService } from '../../pty-processes/index.js';
import type { LaunchPtyProcessInput } from '../../pty-processes/index.js';
import { ptyProcesses } from '../../pty-processes/tables.js';
import { fakeTerminateMany } from '../../pty-processes/testing.js';
import { AgentSessionRepository } from '../agent-sessions/repository.js';
import { AgentSessionService } from '../agent-sessions/service.js';
import { SurfaceService } from '../index.js';
import { SessionLifecycle } from '../sessions/lifecycle.js';
import { restorePaneBoundSessions } from '../sessions/restore.js';
import { SurfaceRepository } from '../surfaces/repository.js';
import { TerminalSessionRepository } from '../terminal-sessions/repository.js';
import { TerminalSessionService } from '../terminal-sessions/service.js';

/**
 * The real session world — one database, real repositories, real agent and
 * terminal services — with the two boundaries that reach outside the process
 * faked: the PTY backend and the harness adapter.
 *
 * This module exists so the restore test and the folder-continuity test share
 * *the* composition rather than each maintaining its own copy. A second graph
 * would let the thing under test drift from the thing that ships. Doubles that
 * belong to a single suite (binding fakes, dying service stubs used to isolate
 * `paneBoundRestoreLayer` itself) deliberately stay local to that suite.
 */

/**
 * The startup restore `SurfaceService.restorePaneBoundSessions` runs, over the session services in
 * context, so a suite can drive it without building the surface service around it.
 */
export const paneBoundRestoreLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const repository = yield* SurfaceRepository;
    const agentSessions = yield* AgentSessionService;
    const terminalSessions = yield* TerminalSessionService;
    yield* restorePaneBoundSessions({ repository, agentSessions, terminalSessions });
  }),
);

/** What the fake harness adapter observed when a launch envelope was built. */
export interface HarnessLaunchRecord {
  readonly agentSessionId: number;
  readonly latest: string | null;
  readonly cwd: string;
  readonly args: readonly string[];
}

export interface SessionWorldOptions {
  /** Every `PtyService.launch` input, in call order. */
  readonly ptyLaunches: LaunchPtyProcessInput[];
  /** Every harness launch envelope built, in call order. */
  readonly harnessLaunches: HarnessLaunchRecord[];
  /**
   * Pins the identifier for each fake PTY process row.
   *
   * Omit it and the database assigns one, which is what a test spanning several
   * scopes needs: a per-instance counter restarts with every scope, so a second
   * scope over the same data directory would re-issue identifiers the first one
   * already used and every insert would collide. Supply it only to assert a
   * specific identifier.
   */
  readonly allocatePtyProcessId?: ((input: LaunchPtyProcessInput) => number) | undefined;
}

/**
 * The layer values behind the session world, returned individually rather than
 * merged.
 *
 * Callers compose the subset they need, and because Effect memoizes a layer by
 * reference, reusing these values yields one database connection, one lock, and
 * one event bus across everything built from them. Re-piping the constructors
 * instead would silently hand different services different databases.
 */
export function sessionWorldLayers(dataRoot: string, options: SessionWorldOptions) {
  const directory = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabase.layer.pipe(Layer.provide(directory));
  const artifacts = AgentSessionArtifacts.layer.pipe(Layer.provide(directory));
  const events = InternalEvents.layer;
  const entityLock = EntityLock.layer;
  const sessionLifecycle = SessionLifecycle.layerNoDeps.pipe(Layer.provide(entityLock));

  const surfaceRepository = SurfaceRepository.layerNoDeps.pipe(
    Layer.provide(database),
    Layer.provide(artifacts),
  );
  const agentRepository = AgentSessionRepository.layerNoDeps.pipe(
    Layer.provide(database),
    Layer.provide(artifacts),
  );
  const terminalRepository = TerminalSessionRepository.layer.pipe(Layer.provide(database));

  const pty = Layer.effect(
    PtyService,
    Effect.map(RuntimeDatabase, (db) => recordingPtyService(db, options)),
  ).pipe(Layer.provide(database));

  const harnessRegistry = Layer.succeed(
    HarnessAdapterRegistry,
    recordingHarnessRegistry(options.harnessLaunches),
  );

  const agentService = AgentSessionService.layerNoDeps.pipe(
    Layer.provide(AllowAllHarnessControlPlaneLayer),
    Layer.provide(agentRepository),
    Layer.provide(pty),
    Layer.provide(harnessRegistry),
    Layer.provide(sessionLifecycle),
    Layer.provide(events),
  );

  const terminalService = TerminalSessionService.layerNoDeps.pipe(
    Layer.provide(terminalRepository),
    Layer.provide(pty),
    Layer.provide(sessionLifecycle),
    Layer.provide(events),
  );

  return {
    directory,
    database,
    artifacts,
    events,
    entityLock,
    sessionLifecycle,
    surfaceRepository,
    agentService,
    terminalService,
    pty,
  } as const;
}

/** Database and artifacts only, for seeding or reading rows outside a service. */
export function sessionDataLayer(dataRoot: string) {
  const directory = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabase.layer.pipe(Layer.provide(directory));
  const artifacts = AgentSessionArtifacts.layer.pipe(Layer.provide(directory));
  return Layer.mergeAll(database, artifacts);
}

/** Startup restore over the real session world. */
export function realRestoreLayer(dataRoot: string, options: SessionWorldOptions) {
  const world = sessionWorldLayers(dataRoot, options);
  return paneBoundRestoreLayer.pipe(
    Layer.provide(world.surfaceRepository),
    Layer.provide(world.agentService),
    Layer.provide(world.terminalService),
  );
}

/**
 * The real session world plus the real `SurfaceService`, so a test can create
 * surfaces, panes, and pane-bound sessions through their owning APIs.
 *
 * That matters beyond tidiness: `createPaneSession` resolves a session's `cwd`
 * from `findWorktreePath(worktreeId)`, so creating through this layer is what
 * makes the worktree path genuinely propagate into the session rows. Seeding
 * those rows by hand would write the path the test already believed and prove
 * nothing about propagation.
 *
 * The editor service dies rather than being wired: `SurfaceService.layerNoDeps` requires
 * it for `openEditor`, which no caller of this layer uses, and a real editor
 * would drag provisioning, port probing, and a socket directory into a session
 * test. A death names the mistake if that assumption ever stops holding.
 */
export function realSessionCreationLayer(dataRoot: string, options: SessionWorldOptions) {
  const world = sessionWorldLayers(dataRoot, options);
  const surfaceService = SurfaceService.layerNoDeps.pipe(
    Layer.provide(world.surfaceRepository),
    Layer.provide(world.agentService),
    Layer.provide(world.terminalService),
    Layer.provide(world.pty),
    Layer.provide(world.sessionLifecycle),
    Layer.provide(world.events),
    Layer.provide(Layer.succeed(EditorContextService, dyingEditorContextService)),
    Layer.provide(world.entityLock),
  );
  return Layer.mergeAll(
    world.database,
    world.artifacts,
    world.surfaceRepository,
    world.agentService,
    world.terminalService,
    surfaceService,
  );
}

/**
 * A PTY backend that records every launch and persists a matching process row,
 * so `activePtyProcessId` points at a row that genuinely exists.
 *
 * It starts no operating-system process. Nothing observed through it supports a
 * claim about a real PID, a real shell, or a real harness.
 */
export function recordingPtyService(
  database: RuntimeDatabase['Service'],
  options: SessionWorldOptions,
): PtyService['Service'] {
  const allocate = options.allocatePtyProcessId;
  return {
    allocateLaunch: () => Effect.die('pty allocateLaunch is not used'),
    readLogTail: () => Effect.die('readLogTail is not used'),
    launch: (input) =>
      Effect.gen(function* () {
        options.ptyLaunches.push(input);
        const now = new Date().toISOString();
        const ptyProcessId = yield* database.use('test_insert_launched_pty_process', (db) => {
          const inserted = db
            .insert(ptyProcesses)
            .values({
              ...(allocate ? { id: allocate(input) } : {}),
              backend: 'node_pty',
              backendRefJson: JSON.stringify({ schemaVersion: 1, backend: 'node_pty', pid: null }),
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
            .returning({ id: ptyProcesses.id })
            .get();
          // The backend reference names the row, so it can only be written once
          // the row has an identifier.
          db.update(ptyProcesses)
            .set({
              backendRefJson: JSON.stringify({
                schemaVersion: 1,
                backend: 'node_pty',
                ptyProcessId: inserted.id,
                pid: null,
              }),
            })
            .where(eq(ptyProcesses.id, inserted.id))
            .run();
          return inserted.id;
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
    terminateMany: fakeTerminateMany(() => Effect.succeed('terminated_live' as const)),
    findProcess: () => Effect.die('findProcess is not used'),
    pin: () => Effect.void,
    unpin: () => Effect.void,
    cleanupProcess: () => Effect.die('pty cleanupProcess is not used'),
    isPinned: () => Effect.succeed(false),
  } satisfies PtyService['Service'];
}

/**
 * A harness adapter that records the envelope it was asked to build and echoes
 * the resume identity into its arguments, so a test can assert that a stored
 * identity reached both the adapter and the resulting launch specification.
 */
export function recordingHarnessRegistry(
  launches: HarnessLaunchRecord[],
): HarnessAdapterRegistry['Service'] {
  return {
    buildLaunch: (input) =>
      Effect.sync(() => {
        const args = input.latestHarnessSessionId
          ? ['--session', input.latestHarnessSessionId]
          : [];
        launches.push({
          agentSessionId: input.agentSessionId,
          latest: input.latestHarnessSessionId,
          cwd: input.cwd,
          args,
        });
        return { command: 'pi', args, cwd: input.cwd };
      }),
    buildHeadlessLaunch: () => Effect.die('headless launch is not used'),
  } satisfies HarnessAdapterRegistry['Service'];
}

const dyingEditorContextService: EditorContextService['Service'] = {
  requireAvailable: Effect.die('editor requireAvailable is not used by session tests'),
  findForWorktree: () => Effect.die('editor findForWorktree is not used by session tests'),
  createForWorktree: () => Effect.die('editor createForWorktree is not used by session tests'),
  ensureRuntime: () => Effect.die('editor ensureRuntime is not used by session tests'),
  releaseIncarnation: () => Effect.die('editor releaseIncarnation is not used by session tests'),
  readinessFor: () => Effect.die('editor readinessFor is not used by session tests'),
  diagnostics: () => Effect.die('editor diagnostics is not used by session tests'),
};

/** Startup restore reports through `console`; these tests read what it reported. */
export async function captureStartupLogs(run: () => Promise<void>) {
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
