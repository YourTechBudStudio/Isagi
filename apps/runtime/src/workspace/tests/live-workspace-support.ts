import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Layer } from 'effect';

import { CommandService } from '../../commands/index.js';
import { AgentSessionService, SurfaceService } from '../../environment/index.js';
import { listDurableSessionInventory } from '../../environment/testing.js';
import { InternalEvents } from '../../platform/events/index.js';
import { Git } from '../../platform/git/index.js';
import { DataDirectory, RuntimeDatabase } from '../../platform/persistence/index.js';
import { makeTestDataDirectory } from '../../platform/persistence/testing.js';
import { ProjectRepository } from '../../projects/index.js';
import { PtyService } from '../../pty-processes/index.js';
import { WorktreeDeleteDiagnosticsReader } from '../delete-diagnostics.js';
import { ProjectDeletionParticipant } from '../project-deletion-participant.js';
import { WorkspaceService } from '../service.js';
import { WorktreeSetupRepository } from '../setup/repository.js';
import { WorktreeSetupService } from '../setup/service.js';
import { StateFile } from '../state-file.js';
import {
  stateFileWithWriteCounter,
  testInternalEvents,
  testPtyService,
  testAgentSessionService,
  testSurfaceService,
  testWorktreeSetup,
  testWorktreeSetupRepository,
} from './test-support.js';

/**
 * The real workspace service over a real database, the real repository and real
 * Git — the only harness in this suite that can answer "what does registering an
 * actual directory do". `repository-test-support.ts` stops at the repository and
 * `api-test-support.ts` starts at the routes; this sits between them.
 *
 * Both decorators wrap the *real* implementation rather than replacing it, so a
 * test can record or forbid individual operations while everything else still
 * genuinely runs. Success fixtures alone cannot inject an operational failure,
 * and a real Git that must not be called cannot prove it was not called.
 */
export interface LiveWorkspaceOptions {
  readonly decorateGit?: ((inner: Git['Service']) => Git['Service']) | undefined;
  readonly decorateRepository?:
    | ((inner: ProjectRepository['Service']) => ProjectRepository['Service'])
    | undefined;
  /**
   * `runPostCreateLifecycle` dies by default: no phase-05 path may run it, so a
   * regression should name itself rather than slip past a counter.
   */
  readonly commands?: Partial<CommandService['Service']> | undefined;
  /**
   * Replaces the silent event bus. Deletion tests need the published events and
   * their order relative to the database cascade; everything else is happy not
   * to look.
   */
  readonly internalEvents?: InternalEvents['Service'] | undefined;
  /**
   * Replaces the `not_configured` trust stub. Setup outcomes are decided by trust state and hook
   * config, neither of which a real Git repository can express, so a test that wants `configured`
   * or `setup_trust_required` supplies the service that answers it.
   */
  readonly worktreeSetup?: WorktreeSetupService['Service'] | undefined;
  /** Replaces the setup-run recording stub, for tests that assert on the recorded run. */
  readonly worktreeSetupRepository?: WorktreeSetupRepository['Service'] | undefined;
  /**
   * An existing database connection to use instead of opening one in the data directory, so a
   * fixture that already owns one (the workflow persistence fixture) and the workspace service read
   * and write the same rows.
   */
  readonly database?: RuntimeDatabase['Service'] | undefined;
  /**
   * An existing database layer to share instead, for a test that composes the workspace with
   * another module's real services in one build (one connection, one memoized layer).
   */
  readonly databaseLayer?: Layer.Layer<RuntimeDatabase, unknown> | undefined;
  /**
   * The participant project deletion runs inside its transaction. Defaults to
   * `NoProjectDeletionParticipant`; cross-module tests in `app/tests` pass the real workflow
   * erasure, or a throwing one to observe the rollback.
   */
  readonly projectDeletionParticipant?: Layer.Layer<ProjectDeletionParticipant> | undefined;
  /** Wraps the real worktree delete-diagnostics read, so a test can record or forbid it. */
  readonly decorateDeleteDiagnostics?:
    | ((
        inner: WorktreeDeleteDiagnosticsReader['Service'],
      ) => WorktreeDeleteDiagnosticsReader['Service'])
    | undefined;
  /**
   * Wraps the surface reads the workspace makes. Surface metadata and focus are empty; the durable
   * session inventory is read from the real database, because deletion announces exactly those
   * sessions.
   */
  readonly decorateSurfaces?:
    | ((inner: SurfaceService['Service']) => SurfaceService['Service'])
    | undefined;
  /** The agent sessions a delete holds and releases; holding and releasing do nothing by default. */
  readonly agentSessions?: AgentSessionService['Service'] | undefined;
  /** The real agent-session service of a shared session world; overrides `agentSessions`. */
  readonly agentSessionsLayer?: Layer.Layer<AgentSessionService, unknown> | undefined;
}

/** A deletion participant with nothing to erase, for workspace tests that own no other module. */
export const NoProjectDeletionParticipant = Layer.succeed(
  ProjectDeletionParticipant,
  ProjectDeletionParticipant.of({ eraseInTransaction: () => 0 }),
);

const baseCommands = {
  listForWorktree: () => Effect.die('command list is not used by live workspace tests'),
  readLogMetadata: () => Effect.die('command log metadata is not used by live workspace tests'),
  run: () => Effect.die('command run is not used by live workspace tests'),
  stop: () => Effect.die('command stop is not used by live workspace tests'),
  restart: () => Effect.die('command restart is not used by live workspace tests'),
  runPostCreateLifecycle: () =>
    Effect.die('postCreate must not run from registration or reconciliation'),
  cleanupBeforeWorktreeDelete: () =>
    Effect.die('delete cleanup is not used by live workspace tests'),
  cleanupBeforeWorktreePrune: () => Effect.void,
} satisfies CommandService['Service'];

/**
 * Runs `build` against a live workspace rooted in its own temporary data
 * directory.
 *
 * The runtime's data directory is deliberately *not* inside any fixture project
 * folder: these tests assert that registering a folder leaves its contents
 * untouched, and a database writing into the directory under inspection would
 * make that assertion meaningless.
 */
export function runWithLiveWorkspace<A, E>(
  name: string,
  options: LiveWorkspaceOptions,
  build: Effect.Effect<A, E, RuntimeDatabase | ProjectRepository | WorkspaceService>,
) {
  // Deliberately *not* canonicalized here. `os.tmpdir()` is a symlink on macOS, so this root is a
  // genuine instance of the case the product has to handle, and `makeTestDataDirectory` resolves it
  // through the same derivation the runtime uses. Normalizing it in the fixture would make the one
  // test that checks Isagi's paths against Git's pass for the fixture's reason rather than the
  // product's.
  const dataRoot = mkdtempSync(join(tmpdir(), `isagi-${name}-`));
  return Effect.runPromise(
    build.pipe(Effect.provide(liveWorkspaceLayer(dataRoot, options))),
  ).finally(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });
}

/**
 * The workspace graph as a layer, for callers that own the data directory
 * themselves — a test spanning several scopes over one directory cannot use
 * `runWithLiveWorkspace`, which allocates and removes its own.
 *
 * One graph, built once. `database` and `repository` are held as values and
 * referenced wherever they are needed rather than re-piped, so the whole test
 * observes a single SQLite connection — two constructions would silently give
 * the service and the assertions different databases.
 */
export function liveWorkspaceLayer(dataRoot: string, options: LiveWorkspaceOptions) {
  const dataDirectoryLayer = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database =
    options.databaseLayer ??
    (options.database
      ? Layer.succeed(RuntimeDatabase, options.database)
      : RuntimeDatabase.layer.pipe(Layer.provide(dataDirectoryLayer)));
  const realRepository = ProjectRepository.layer.pipe(Layer.provide(database));
  const repository = options.decorateRepository
    ? Layer.effect(
        ProjectRepository,
        Effect.map(ProjectRepository, options.decorateRepository),
      ).pipe(Layer.provide(realRepository))
    : realRepository;
  const git = options.decorateGit
    ? Layer.effect(Git, Effect.map(Git, options.decorateGit)).pipe(Layer.provide(Git.layer))
    : Git.layer;
  const decorateDeleteDiagnostics = options.decorateDeleteDiagnostics ?? ((inner) => inner);
  const deleteDiagnostics = Layer.effect(
    WorktreeDeleteDiagnosticsReader,
    Effect.map(WorktreeDeleteDiagnosticsReader, decorateDeleteDiagnostics),
  ).pipe(Layer.provide(WorktreeDeleteDiagnosticsReader.layer), Layer.provide(database));
  const decorateSurfaces = options.decorateSurfaces ?? ((inner) => inner);
  const surfaces = Layer.effect(
    SurfaceService,
    Effect.map(RuntimeDatabase, (db) =>
      decorateSurfaces({
        ...testSurfaceService,
        listDurableSessions: listDurableSessionInventory(db),
      }),
    ),
  ).pipe(Layer.provide(database));

  const workspace = WorkspaceService.layerNoDeps.pipe(
    Layer.provide(
      Layer.mergeAll(
        options.projectDeletionParticipant ?? NoProjectDeletionParticipant,
        repository,
        git,
        dataDirectoryLayer,
        Layer.succeed(CommandService, { ...baseCommands, ...options.commands }),
        Layer.succeed(PtyService, testPtyService),
        Layer.succeed(InternalEvents, options.internalEvents ?? testInternalEvents),
        surfaces,
        options.agentSessionsLayer ??
          Layer.succeed(AgentSessionService, options.agentSessions ?? testAgentSessionService),
        deleteDiagnostics,
        Layer.succeed(
          StateFile,
          stateFileWithWriteCounter(() => {}),
        ),
        Layer.succeed(WorktreeSetupService, options.worktreeSetup ?? testWorktreeSetup),
        Layer.succeed(
          WorktreeSetupRepository,
          options.worktreeSetupRepository ?? testWorktreeSetupRepository,
        ),
      ),
    ),
  );

  return Layer.mergeAll(database, repository, workspace);
}
