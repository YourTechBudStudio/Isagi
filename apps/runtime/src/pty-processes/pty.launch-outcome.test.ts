import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import { DatabaseError, DataDirectory, RuntimeDatabaseLive } from '../persistence/index.js';
import { makeTestDataDirectory } from '../persistence/test-support.js';
import { publishOnlyRecordingEventBus } from '../runtime-events/test-support.js';
import { PtyRepository, PtyRepositoryLive, type PtyRepositoryService } from './pty.repository.js';
import { allocateLaunch, type PtyLaunchDependencies } from './service/launch.js';
import type { PtyReservations } from './service/lifecycle.js';
import { fakeBackendCatalog, manualPtyRetryScheduler } from './test-support.js';
import {
  PtyStartError,
  type BackendSessionRef,
  type PtyBackend as PtyBackendShape,
  type PtyBackendName,
} from './types.js';

/**
 * What a resolved `start` actually was.
 *
 * `start` is deliberately total, so the Effect resolving is evidence of nothing, and a caller that
 * re-derived the answer from the durable row would get the one case that matters backwards: a row
 * marked terminal after a *post-spawn* fault may still have a live process behind it. Each of the
 * three branches is exercised for real here rather than through a synthetic metadata shape.
 */

function backendStub(name: PtyBackendName, overrides: Partial<PtyBackendShape> = {}) {
  return {
    name,
    available: Effect.succeed(true),
    launch: () =>
      Effect.succeed({
        schemaVersion: 1,
        backend: 'node_pty',
        ptyProcessId: 1,
        pid: 4242,
      } satisfies BackendSessionRef),
    writeInput: () => Effect.void,
    attach: () => Effect.die(`${name} attach is not expected here`),
    replay: () => Effect.void,
    inspect: () => Effect.succeed({ status: 'alive' as const }),
    listSessions: Effect.succeed([]),
    kill: () => Effect.succeed({ terminated: true }),
    ...overrides,
  } satisfies PtyBackendShape;
}

interface Harness {
  readonly repository: PtyRepositoryService;
  readonly dependencies: (
    backend: PtyBackendShape,
    repository?: PtyRepositoryService,
  ) => PtyLaunchDependencies;
}

function withHarness<A, E>(body: (harness: Harness) => Effect.Effect<A, E, never>) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-launch-outcome-'));
  const paths = makeTestDataDirectory(dataRoot);
  mkdirSync(paths.paths.sessionsPath, { recursive: true });
  const directory = Layer.succeed(DataDirectory, paths);
  const database = RuntimeDatabaseLive.pipe(Layer.provide(directory));
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const bus = publishOnlyRecordingEventBus('launch outcome tests do not subscribe');
        const reservations: PtyReservations = { terminations: new Map(), launches: new Map() };
        return yield* body({
          repository,
          dependencies: (backend, override) => ({
            repository: override ?? repository,
            catalog: fakeBackendCatalog({
              configured: 'node_pty',
              nodePty: backend,
              tmux: backendStub('tmux', {
                launch: () => Effect.die('tmux is not the configured launch backend here'),
              }),
            }),
            eventBus: bus.service,
            foreground: {
              set: () => Effect.succeed(false),
              clear: () => Effect.succeed(false),
              isWorking: () => false,
            },
            retry: manualPtyRetryScheduler(),
            reservations,
            activeAttachments: new Map(),
            runtimeNamespace: 'testns',
            sessionsPath: paths.paths.sessionsPath,
            userProcessEnvironment: {},
          }),
        });
      }).pipe(Effect.provide(PtyRepositoryLive.pipe(Layer.provide(database)))),
    ),
  ).finally(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });
}

test('a successful spawn reports `spawned` with no failure cause', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const allocation = yield* allocateLaunch(harness.dependencies(backendStub('node_pty')), {
        command: 'pnpm',
        args: ['dev'],
        cwd: '/repo/isagi',
      });
      const metadata = yield* allocation.start;
      assert.equal(metadata.launchOutcome, 'spawned');
      assert.equal(metadata.launchFailureCause, null);
    }),
  );
});

test('a preparation failure reports `preparation_failed`, because nothing reached a backend', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const failing: PtyRepositoryService = {
        ...harness.repository,
        updateBackendMetadata: () =>
          Effect.fail(
            new DatabaseError({
              operation: 'update_pty_backend_metadata',
              cause: new Error('disk full'),
            }),
          ),
      };
      const allocation = yield* allocateLaunch(
        harness.dependencies(
          backendStub('node_pty', {
            launch: () => Effect.die('the backend must not be reached after a preparation fault'),
          }),
          failing,
        ),
        { command: 'pnpm', args: ['dev'], cwd: '/repo/isagi' },
      );

      const metadata = yield* allocation.start;

      // Pre-boundary: no session can ever materialize for this row, which is what makes settling a
      // workflow operation `abandoned` and leaving dispatch eligible sound.
      assert.equal(metadata.launchOutcome, 'preparation_failed');
      assert.match(metadata.launchFailureCause ?? '', /disk full/);
    }),
  );
});

test('a post-spawn setup failure reports `spawn_failed`, not a preparation failure', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      // Injected where it actually occurs: the backend's own launch wraps the spawn *and* its
      // listener registration in one try, so a throw after a successful spawn surfaces as
      // `PtyStartError` with the process already running.
      const allocation = yield* allocateLaunch(
        harness.dependencies(
          backendStub('node_pty', {
            launch: () =>
              Effect.fail(
                new PtyStartError({
                  command: 'pnpm',
                  cwd: '/repo/isagi',
                  cause: new Error('onData registration threw after the spawn'),
                }),
              ),
          }),
        ),
        { command: 'pnpm', args: ['dev'], cwd: '/repo/isagi' },
      );

      const metadata = yield* allocation.start;

      assert.equal(metadata.launchOutcome, 'spawn_failed');
      assert.match(metadata.launchFailureCause ?? '', /onData registration/);

      // The distinction this exists for: the durable row reads terminal, and that is *not* evidence
      // that nothing executed. A caller re-deriving the outcome from row status would classify this
      // the same as a preparation failure, and could then dispatch a second headless agent under
      // the same operation identity while the first is still running in the person's worktree.
      const row = yield* harness.repository.findProcess(allocation.ptyProcessId);
      assert.equal(row?.status, 'failed');
      assert.notEqual(metadata.launchOutcome, 'preparation_failed');
    }),
  );
});
