import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Cause, Deferred, Effect, Exit, Fiber, Layer } from 'effect';

import { DatabaseError, DataDirectory, RuntimeDatabaseLive } from '../persistence/index.js';
import { makeTestDataDirectory } from '../persistence/test-support.js';
import type {
  InternalRuntimeEvent,
  InternalRuntimeEventBusService,
} from '../runtime-events/index.js';
import { PtyRepository, PtyRepositoryLive, type PtyRepositoryService } from './pty.repository.js';
import { reconcilePersistedProcesses } from './pty.service.js';
import { collectPtyGarbage } from './service/gc.js';
import { allocateLaunch, type PtyLaunchDependencies } from './service/launch.js';
import type { PtyReservations } from './service/lifecycle.js';
import { fakeBackendCatalog, manualPtyRetryScheduler } from './test-support.js';
import {
  PtyStartError,
  type BackendSessionRef,
  type PtyBackend as PtyBackendShape,
  type PtyBackendName,
} from './types.js';

// The allocation-to-process window. Everything here defends one property: from
// the instant a row exists until a launch resolves, exactly one owner is
// responsible for it, and no generic observer may assign it an outcome.

function recordingEventBus() {
  const events: InternalRuntimeEvent[] = [];
  const service: InternalRuntimeEventBusService = {
    publish: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    subscribe: () => Effect.die('launch allocation tests do not subscribe'),
  };
  return { events, service };
}

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

function catalogWith(nodePty: PtyBackendShape) {
  return fakeBackendCatalog({
    configured: 'node_pty',
    nodePty,
    tmux: backendStub('tmux', {
      launch: () => Effect.die('the tmux adapter is not the configured launch backend here'),
    }),
  });
}

interface Harness {
  readonly repository: PtyRepositoryService;
  readonly bus: ReturnType<typeof recordingEventBus>;
  readonly reservations: PtyReservations;
  readonly sessionsPath: string;
  readonly dependencies: (
    backend: PtyBackendShape,
    repository?: PtyRepositoryService,
  ) => PtyLaunchDependencies;
}

// A real repository over a temp database: co-visibility of the row and its
// reservation, and the transactional insert, are exactly what is under test.
function withHarness<A, E>(body: (harness: Harness) => Effect.Effect<A, E, never>) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-allocation-'));
  const paths = makeTestDataDirectory(dataRoot);
  // `PtyServiceLive` does this at startup; these tests drive the launch module
  // directly, so the log directory has to exist here too.
  mkdirSync(paths.paths.sessionsPath, { recursive: true });
  const directory = Layer.succeed(DataDirectory, paths);
  const database = RuntimeDatabaseLive.pipe(Layer.provide(directory));
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const bus = recordingEventBus();
        const reservations: PtyReservations = { terminations: new Map(), launches: new Map() };
        return yield* body({
          repository,
          bus,
          reservations,
          sessionsPath: paths.paths.sessionsPath,
          dependencies: (backend, override) => ({
            repository: override ?? repository,
            catalog: catalogWith(backend),
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

test('the launch reservation is visible in the same write as the row', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      // The proof has to happen inside the repository's own write section: by
      // the time `allocateLaunch` returns, an observer could already have run.
      let reservedAtInsert: boolean | null = null;
      const observing: PtyRepositoryService = {
        ...harness.repository,
        createProcessMetadata: (input) =>
          harness.repository.createProcessMetadata({
            ...input,
            onInserted: (ptyProcessId) => {
              input.onInserted?.(ptyProcessId);
              reservedAtInsert = harness.reservations.launches.has(ptyProcessId);
            },
          }),
      };

      const allocation = yield* allocateLaunch(
        harness.dependencies(backendStub('node_pty'), observing),
        { command: 'pnpm', args: ['dev'], cwd: '/repo/isagi' },
      );

      assert.equal(reservedAtInsert, true);
      assert.equal(harness.reservations.launches.has(allocation.ptyProcessId), true);
      const row = yield* harness.repository.findProcess(allocation.ptyProcessId);
      assert.equal(row?.status, 'starting');
      yield* allocation.abandon;
    }),
  );
});

test('an acquisition fault after the hook ran strands no reservation', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      // Models a commit-level fault: the hook has already run, so only the
      // closure-captured compensation can release the entry.
      let hooked: number | null = null;
      const failing: PtyRepositoryService = {
        ...harness.repository,
        createProcessMetadata: (input) =>
          Effect.sync(() => {
            hooked = 99;
            input.onInserted?.(99);
          }).pipe(
            Effect.zipRight(
              Effect.fail(
                new DatabaseError({
                  operation: 'create_pty_process_metadata',
                  cause: new Error('commit failed'),
                }),
              ),
            ),
          ),
      };

      const result = yield* allocateLaunch(harness.dependencies(backendStub('node_pty'), failing), {
        command: 'pnpm',
        args: ['dev'],
        cwd: '/repo/isagi',
      }).pipe(Effect.either);

      assert.equal(result._tag, 'Left');
      assert.equal(hooked, 99);
      assert.equal(harness.reservations.launches.size, 0);
    }),
  );
});

test('a poller pass between allocate and start leaves the row starting', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      // Without the reservation the poller would find no process for this
      // `starting` row and mark it failed — permanently, under terminal
      // immutability — while the launch went on to start successfully.
      const backend = backendStub('node_pty', {
        inspect: () => Effect.succeed({ status: 'missing' as const }),
      });
      const deps = harness.dependencies(backend);
      const allocation = yield* allocateLaunch(deps, {
        command: 'pnpm',
        args: ['dev'],
        cwd: '/repo/isagi',
      });

      yield* reconcilePersistedProcesses(
        harness.repository,
        catalogWith(backend),
        harness.bus.service,
        harness.reservations,
        { startup: false },
      );

      const reserved = yield* harness.repository.findProcess(allocation.ptyProcessId);
      assert.equal(reserved?.status, 'starting');
      assert.deepEqual(harness.bus.events, []);

      const metadata = yield* allocation.start;
      assert.equal(metadata.ptyProcessId, allocation.ptyProcessId);
      const started = yield* harness.repository.findProcess(allocation.ptyProcessId);
      assert.equal(started?.status, 'running');
      assert.equal(harness.reservations.launches.size, 0);
    }),
  );
});

test('abandon marks a never-started allocation and releases its reservation', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const allocation = yield* allocateLaunch(harness.dependencies(backendStub('node_pty')), {
        command: 'pnpm',
        args: ['dev'],
        cwd: '/repo/isagi',
      });

      yield* allocation.abandon;
      yield* allocation.abandon;

      const row = yield* harness.repository.findProcess(allocation.ptyProcessId);
      assert.equal(row?.status, 'failed');
      assert.equal(row?.statusReason, 'backend_launch_failed');
      assert.equal(harness.reservations.launches.size, 0);
      assert.equal(harness.bus.events.length, 1);
    }),
  );
});

test('an allocation starts at most once and cannot be abandoned after starting', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const allocation = yield* allocateLaunch(harness.dependencies(backendStub('node_pty')), {
        command: 'pnpm',
        args: ['dev'],
        cwd: '/repo/isagi',
      });

      yield* allocation.start;
      // A no-op, not a terminal write: the process this allocation started is
      // alive and owned by its caller.
      yield* allocation.abandon;
      const afterAbandon = yield* harness.repository.findProcess(allocation.ptyProcessId);
      assert.equal(afterAbandon?.status, 'running');

      const second = yield* Effect.exit(allocation.start);
      assert.equal(Exit.isFailure(second), true);
      // A defect, not a recoverable failure: starting twice is a caller bug.
      assert.equal(Exit.isFailure(second) && Cause.isDie(second.cause), true);
    }),
  );
});

test('cancelling before the spawn marks the launch failed and releases', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      // Interrupts a non-completing `envForProcess` rather than a convenient
      // yield point: pre-spawn cancellation is quiescence-safe precisely
      // because nothing has reached a backend.
      const entered = yield* Deferred.make<void>();
      const allocation = yield* allocateLaunch(
        harness.dependencies(
          backendStub('node_pty', {
            launch: () => Effect.die('a cancelled pre-spawn launch must not reach the backend'),
          }),
        ),
        {
          command: 'pnpm',
          args: ['dev'],
          cwd: '/repo/isagi',
          envForProcess: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Effect.never)),
        },
      );

      const fiber = yield* Effect.fork(allocation.start);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);

      const row = yield* harness.repository.findProcess(allocation.ptyProcessId);
      assert.equal(row?.status, 'failed');
      assert.equal(row?.statusReason, 'backend_launch_failed');
      assert.equal(harness.reservations.launches.size, 0);
    }),
  );
});

test('cancelling mid-spawn never terminalizes off an absence observation', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      // The abort proves the client died, not that the backend refused. An
      // absent session persists nothing, so a session that materializes later
      // is still adoptable.
      const entered = yield* Deferred.make<void>();
      let alive = false;
      let kills = 0;
      const backend = backendStub('node_pty', {
        launch: () => Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Effect.never)),
        inspect: () => Effect.succeed({ status: alive ? 'alive' : ('missing' as const) }),
        kill: () =>
          Effect.sync(() => {
            kills += 1;
            return { terminated: alive };
          }),
      });
      const allocation = yield* allocateLaunch(harness.dependencies(backend), {
        command: 'pnpm',
        args: ['dev'],
        cwd: '/repo/isagi',
      });

      const fiber = yield* Effect.fork(allocation.start);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);

      assert.equal(kills, 1);
      const row = yield* harness.repository.findProcess(allocation.ptyProcessId);
      assert.equal(row?.status, 'starting');
      assert.equal(harness.reservations.launches.size, 0);
      assert.equal(harness.reservations.terminations.size, 0);

      // The session the aborted request had already created shows up after the
      // cleanup looked. The poller — no longer blocked by a reservation — adopts
      // it, which is what keeps it stoppable through its persisted row.
      alive = true;
      yield* reconcilePersistedProcesses(
        harness.repository,
        catalogWith(backend),
        harness.bus.service,
        harness.reservations,
        { startup: false },
      );
      const adopted = yield* harness.repository.findProcess(allocation.ptyProcessId);
      assert.equal(adopted?.status, 'running');
    }),
  );
});

test('a hung spawn keeps its reservation and stays out of the poller', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const backend = backendStub('node_pty', {
        launch: () => Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Effect.never)),
        inspect: () => Effect.succeed({ status: 'missing' as const }),
      });
      const allocation = yield* allocateLaunch(harness.dependencies(backend), {
        command: 'pnpm',
        args: ['dev'],
        cwd: '/repo/isagi',
      });

      const fiber = yield* Effect.fork(allocation.start);
      yield* Deferred.await(entered);

      yield* reconcilePersistedProcesses(
        harness.repository,
        catalogWith(backend),
        harness.bus.service,
        harness.reservations,
        { startup: false },
      );

      // Correctly held: the launch really is still starting.
      assert.equal(harness.reservations.launches.has(allocation.ptyProcessId), true);
      const row = yield* harness.repository.findProcess(allocation.ptyProcessId);
      assert.equal(row?.status, 'starting');
      yield* Fiber.interrupt(fiber);
    }),
  );
});

test('a pre-spawn persistence failure folds and still returns metadata', async () => {
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

      assert.equal(metadata.ptyProcessId, allocation.ptyProcessId);
      const row = yield* harness.repository.findProcess(allocation.ptyProcessId);
      assert.equal(row?.status, 'failed');
      assert.equal(row?.statusReason, 'backend_launch_failed');
      assert.equal(harness.reservations.launches.size, 0);
    }),
  );
});

test('a spawn failure whose fold write also fails still returns metadata', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      // Both faults absorbed: the row stays `starting` and is classified by the
      // poller, which is the documented second-fault path.
      const failing: PtyRepositoryService = {
        ...harness.repository,
        transitionProcess: () =>
          Effect.fail(
            new DatabaseError({ operation: 'transition_pty_process', cause: new Error('locked') }),
          ),
      };
      const allocation = yield* allocateLaunch(
        harness.dependencies(
          backendStub('node_pty', {
            launch: () =>
              Effect.fail(
                new PtyStartError({
                  command: 'pnpm',
                  cwd: '/repo/isagi',
                  cause: new Error('nope'),
                }),
              ),
          }),
          failing,
        ),
        { command: 'pnpm', args: ['dev'], cwd: '/repo/isagi' },
      );

      const metadata = yield* allocation.start;

      assert.equal(metadata.ptyProcessId, allocation.ptyProcessId);
      const row = yield* harness.repository.findProcess(allocation.ptyProcessId);
      assert.equal(row?.status, 'starting');
      assert.equal(harness.reservations.launches.size, 0);
    }),
  );
});

test('a post-launch persistence failure returns metadata without killing', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      // The compensation kill is gone: the process is live and inspectable
      // through the metadata written before the spawn, so the poller heals the
      // row instead of the launch destroying a working process.
      let killed = 0;
      const backend = backendStub('node_pty', {
        kill: () =>
          Effect.sync(() => {
            killed += 1;
            return { terminated: true };
          }),
      });
      const failing: PtyRepositoryService = {
        ...harness.repository,
        updateBackendRef: () =>
          Effect.fail(
            new DatabaseError({ operation: 'update_pty_backend_ref', cause: new Error('locked') }),
          ),
      };
      const allocation = yield* allocateLaunch(harness.dependencies(backend, failing), {
        command: 'pnpm',
        args: ['dev'],
        cwd: '/repo/isagi',
      });

      const metadata = yield* allocation.start;

      assert.equal(metadata.ptyProcessId, allocation.ptyProcessId);
      assert.equal(killed, 0);
      assert.equal(harness.reservations.launches.size, 0);
      const row = yield* harness.repository.findProcess(allocation.ptyProcessId);
      assert.equal(row?.status, 'starting');

      yield* reconcilePersistedProcesses(
        harness.repository,
        catalogWith(backend),
        harness.bus.service,
        harness.reservations,
        { startup: false },
      );
      const healed = yield* harness.repository.findProcess(allocation.ptyProcessId);
      assert.equal(healed?.status, 'running');
    }),
  );
});

test('a failed final metadata read still returns a launch result without killing', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      // The distinct fault from the one above: everything persisted, but the
      // closing reread of the row fails. The process is live, so the launch
      // degrades to `logPath: null` instead of compensating with a kill.
      let killed = 0;
      const backend = backendStub('node_pty', {
        kill: () =>
          Effect.sync(() => {
            killed += 1;
            return { terminated: true };
          }),
      });
      // Armed only once the `running` transition has landed, so the fault is
      // the closing reread alone and not the persistence before it.
      let readsFail = false;
      const failing: PtyRepositoryService = {
        ...harness.repository,
        transitionProcess: (input) =>
          harness.repository.transitionProcess(input).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (input.status === 'running') readsFail = true;
              }),
            ),
          ),
        findProcess: (ptyProcessId) =>
          readsFail
            ? Effect.fail(
                new DatabaseError({ operation: 'find_pty_process', cause: new Error('locked') }),
              )
            : harness.repository.findProcess(ptyProcessId),
      };
      const allocation = yield* allocateLaunch(harness.dependencies(backend, failing), {
        command: 'pnpm',
        args: ['dev'],
        cwd: '/repo/isagi',
      });

      const metadata = yield* allocation.start;

      assert.equal(metadata.ptyProcessId, allocation.ptyProcessId);
      assert.equal(metadata.logPath, null);
      assert.equal(killed, 0);
      assert.equal(harness.reservations.launches.size, 0);
      // The read failed, but the writes before it did not: the row is `running`
      // and carries the log path the returned metadata could not report.
      const row = yield* harness.repository.findProcess(allocation.ptyProcessId);
      assert.equal(row?.status, 'running');
      assert.notEqual(row?.logPath, null);
    }),
  );
});

test('a launch pending past the retention window is excluded from orphan GC', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const backend = backendStub('node_pty');
      const allocation = yield* allocateLaunch(harness.dependencies(backend), {
        command: 'pnpm',
        args: ['dev'],
        cwd: '/repo/isagi',
      });

      // Far past the five-minute retention window: without the exclusion the
      // row and its live process would be collected mid-launch.
      yield* collectPtyGarbage(
        harness.repository,
        catalogWith(backend),
        'testns',
        harness.sessionsPath,
        {
          nowMs: Date.now() + 60 * 60_000,
          pendingLaunches: harness.reservations.launches,
        },
      );

      const row = yield* harness.repository.findProcess(allocation.ptyProcessId);
      assert.notEqual(row, null);
      yield* allocation.abandon;
    }),
  );
});
