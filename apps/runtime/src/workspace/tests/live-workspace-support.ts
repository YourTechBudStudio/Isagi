import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Layer } from 'effect';

import { CommandService, type CommandServiceShape } from '../../commands/index.js';
import { Git, GitLive, type GitService } from '../../git/index.js';
import {
  DataDirectory,
  RuntimeDatabaseLive,
  type RuntimeDatabaseService,
  StateFile,
} from '../../persistence/index.js';
import { makeTestDataDirectory } from '../../persistence/test-support.js';
import { PtyService } from '../../pty-processes/index.js';
import {
  InternalRuntimeEventBus,
  type InternalRuntimeEventBusService,
} from '../../runtime-events/index.js';
import { SurfaceRepository } from '../../surfaces/index.js';
import { WorktreeSetupRepository, WorktreeSetupService } from '../../worktree-setup/index.js';
import {
  WorkspaceRepository,
  WorkspaceRepositoryLive,
  type WorkspaceRepositoryService,
} from '../workspace.repository.js';
import { WorkspaceService } from '../workspace.service.js';
import { WorkspaceServiceLive } from '../workspace.service.js';
import {
  stateFileWithWriteCounter,
  testInternalEvents,
  testPtyService,
  testSurfaceRepository,
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
  readonly decorateGit?: ((inner: GitService) => GitService) | undefined;
  readonly decorateRepository?:
    | ((inner: WorkspaceRepositoryService) => WorkspaceRepositoryService)
    | undefined;
  /**
   * `runPostCreateLifecycle` dies by default: no phase-05 path may run it, so a
   * regression should name itself rather than slip past a counter.
   */
  readonly commands?: Partial<CommandServiceShape> | undefined;
  /**
   * Replaces the silent event bus. Deletion tests need the published events and
   * their order relative to the database cascade; everything else is happy not
   * to look.
   */
  readonly internalEvents?: InternalRuntimeEventBusService | undefined;
}

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
} satisfies CommandServiceShape;

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
  build: Effect.Effect<
    A,
    E,
    RuntimeDatabaseService | WorkspaceRepositoryService | WorkspaceService
  >,
) {
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
  const database = RuntimeDatabaseLive.pipe(Layer.provide(dataDirectoryLayer));
  const realRepository = WorkspaceRepositoryLive.pipe(Layer.provide(database));
  const repository = options.decorateRepository
    ? Layer.effect(
        WorkspaceRepository,
        Effect.map(WorkspaceRepository, options.decorateRepository),
      ).pipe(Layer.provide(realRepository))
    : realRepository;
  const git = options.decorateGit
    ? Layer.effect(Git, Effect.map(Git, options.decorateGit)).pipe(Layer.provide(GitLive))
    : GitLive;

  const workspace = WorkspaceServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        repository,
        git,
        dataDirectoryLayer,
        Layer.succeed(CommandService, { ...baseCommands, ...options.commands }),
        Layer.succeed(PtyService, testPtyService),
        Layer.succeed(InternalRuntimeEventBus, options.internalEvents ?? testInternalEvents),
        Layer.succeed(SurfaceRepository, testSurfaceRepository),
        Layer.succeed(
          StateFile,
          stateFileWithWriteCounter(() => {}),
        ),
        Layer.succeed(WorktreeSetupService, testWorktreeSetup),
        Layer.succeed(WorktreeSetupRepository, testWorktreeSetupRepository),
      ),
    ),
  );

  return Layer.mergeAll(database, repository, workspace);
}
