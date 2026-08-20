import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Either, Fiber, Layer } from 'effect';

import { DatabaseError, DataDirectory, RuntimeDatabaseLive } from '../persistence/index.js';
import { makeTestDataDirectory } from '../persistence/test-support.js';
import type {
  InternalRuntimeEvent,
  InternalRuntimeEventBusService,
} from '../runtime-events/index.js';
import { PtyRepository, PtyRepositoryLive, type PtyRepositoryService } from './pty.repository.js';
import { reconcilePersistedProcesses } from './pty.service.js';
import type { ActiveAttachment } from './service/attachments.js';
import { handleExit, type PtyTerminations } from './service/lifecycle.js';
import { terminatePtyProcess } from './service/termination.js';
import { fakeBackendCatalog, manualPtyRetryScheduler } from './test-support.js';
import {
  PtyKillError,
  PtyTerminationInProgressError,
  type PtyBackend as PtyBackendShape,
  type PtyBackendName,
} from './types.js';

// The attempt-honest outcome table. A stop cause may bind only to an affirmative
// kill, so the distinction these tests defend is: what did *this* attempt do, as
// opposed to what the row happens to say afterwards.

function recordingEventBus() {
  const events: InternalRuntimeEvent[] = [];
  const service: InternalRuntimeEventBusService = {
    publish: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    subscribe: () => Effect.die('termination tests do not subscribe'),
  };
  return { events, service };
}

function backendStub(name: PtyBackendName, overrides: Partial<PtyBackendShape> = {}) {
  return {
    name,
    available: Effect.succeed(true),
    launch: () => Effect.die(`${name} launch is not expected here`),
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
      kill: () => Effect.die('the tmux adapter must never touch a node-pty incarnation'),
    }),
  });
}

interface Harness {
  readonly repository: PtyRepositoryService;
  readonly bus: ReturnType<typeof recordingEventBus>;
  readonly terminations: PtyTerminations;
  readonly retry: ReturnType<typeof manualPtyRetryScheduler>;
  readonly activeAttachments: Map<number, ActiveAttachment>;
  readonly ptyProcessId: number;
}

// A real repository over a temp database: the terminal guard is the thing under
// test in several of these cases, so it must not be faked.
function withHarness<A, E>(body: (harness: Harness) => Effect.Effect<A, E, never>) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-termination-'));
  const directory = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabaseLive.pipe(Layer.provide(directory));
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const ptyProcessId = yield* repository.createProcessMetadata({
          command: 'pnpm',
          args: ['dev'],
          cwd: '/repo/isagi',
        });
        yield* repository.transitionProcess({ ptyProcessId, status: 'running' });
        return yield* body({
          repository,
          bus: recordingEventBus(),
          terminations: new Map(),
          retry: manualPtyRetryScheduler(),
          activeAttachments: new Map(),
          ptyProcessId,
        });
      }).pipe(Effect.provide(PtyRepositoryLive.pipe(Layer.provide(database)))),
    ),
  ).finally(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });
}

function terminate(
  harness: Harness,
  backend: PtyBackendShape,
  repository: PtyRepositoryService = harness.repository,
) {
  return terminatePtyProcess({
    repository,
    catalog: catalogWith(backend),
    eventBus: harness.bus.service,
    activeAttachments: harness.activeAttachments,
    terminations: harness.terminations,
    retry: harness.retry,
    ptyProcessId: harness.ptyProcessId,
    reason: 'user_requested',
  });
}

test('an affirmative kill is terminated_live and persists the killed fact', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const outcome = yield* terminate(harness, backendStub('node_pty'));

      assert.equal(outcome, 'terminated_live');
      const row = yield* harness.repository.findProcess(harness.ptyProcessId);
      assert.equal(row?.status, 'killed');
      assert.equal(row?.statusReason, 'user_requested');
      assert.equal(harness.bus.events.length, 1);
      assert.equal(harness.terminations.size, 0);
    }),
  );
});

test('a backend that found nothing to kill persists nothing and reports already_absent', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const outcome = yield* terminate(
        harness,
        backendStub('node_pty', { kill: () => Effect.succeed({ terminated: false }) }),
      );

      assert.equal(outcome, 'already_absent');
      // The false `killed` an unconditional write used to record for an absent
      // session is gone: the incarnation's terminal fact stays owned by whatever
      // actually ends it.
      const row = yield* harness.repository.findProcess(harness.ptyProcessId);
      assert.equal(row?.status, 'running');
      assert.deepEqual(harness.bus.events, []);
      assert.equal(harness.terminations.size, 0);
    }),
  );
});

test('a kill that errors while an exit arrives is already_absent, and the exit is independent evidence', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const backend = backendStub('node_pty', {
        kill: () =>
          Effect.gen(function* () {
            // The process died on its own while this attempt was failing. Binding
            // a stop cause here would turn an independent exit into resume intent.
            yield* handleExit(
              harness.repository,
              harness.bus.service,
              harness.retry,
              harness.activeAttachments,
              harness.terminations,
              harness.ptyProcessId,
              { exitCode: 3, signal: null },
            );
            return yield* Effect.fail(new PtyKillError({ cause: new Error('kill failed') }));
          }),
      });

      const outcome = yield* terminate(harness, backend);

      assert.equal(outcome, 'already_absent');
      const row = yield* harness.repository.findProcess(harness.ptyProcessId);
      assert.equal(row?.status, 'failed');
      assert.equal(row?.exitCode, 3);
      assert.equal(row?.statusReason, null);
      assert.equal(harness.terminations.size, 0);
    }),
  );
});

test('an absent backend with a captured exit persists that exit and reports already_absent', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const backend = backendStub('node_pty', {
        kill: () =>
          handleExit(
            harness.repository,
            harness.bus.service,
            harness.retry,
            harness.activeAttachments,
            harness.terminations,
            harness.ptyProcessId,
            { exitCode: 0, signal: null },
          ).pipe(Effect.as({ terminated: false })),
      });

      const outcome = yield* terminate(harness, backend);

      assert.equal(outcome, 'already_absent');
      const row = yield* harness.repository.findProcess(harness.ptyProcessId);
      assert.equal(row?.status, 'exited');
      assert.equal(harness.terminations.size, 0);
    }),
  );
});

test('an affirmative kill discards its own captured exit and records killed', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      // A graceful node-pty termination routinely produces this callback. The
      // exit describes the death this attempt caused, not an independent cause.
      const backend = backendStub('node_pty', {
        kill: () =>
          handleExit(
            harness.repository,
            harness.bus.service,
            harness.retry,
            harness.activeAttachments,
            harness.terminations,
            harness.ptyProcessId,
            { exitCode: 0, signal: 'SIGTERM' },
          ).pipe(Effect.as({ terminated: true })),
      });

      const outcome = yield* terminate(harness, backend);

      assert.equal(outcome, 'terminated_live');
      const row = yield* harness.repository.findProcess(harness.ptyProcessId);
      assert.equal(row?.status, 'killed');
      assert.equal(row?.statusReason, 'user_requested');
      assert.equal(harness.terminations.size, 0);
    }),
  );
});

test('a kill that fails with no exit writes nothing and surfaces the failure', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const outcome = yield* terminate(
        harness,
        backendStub('node_pty', {
          kill: () => Effect.fail(new PtyKillError({ cause: new Error('no evidence') })),
        }),
      ).pipe(Effect.either);

      assert.equal(Either.isLeft(outcome), true);
      assert.ok(Either.isLeft(outcome) && outcome.left instanceof PtyKillError);
      // The process may well still be alive, so the row stays honest.
      const row = yield* harness.repository.findProcess(harness.ptyProcessId);
      assert.equal(row?.status, 'running');
      assert.equal(harness.terminations.size, 0);
    }),
  );
});

// The deferred-write paths below are the phase's central irreversible guarantee:
// while a terminal write is unpersisted the row stays reserved, and the
// reservation must be released exactly when that write is settled — whether it
// finally applies or is rejected by a terminal fact that got there first.

// Fails the given number of writes, then defers to the real repository. Enough
// to drive failure → resolution deterministically without faking the guard that
// decides whether a late write applies at all.
function repositoryFailingWrites(
  harness: Harness,
  failures: number,
): { readonly repository: PtyRepositoryService; readonly attempts: () => number } {
  let remaining = failures;
  let attempts = 0;
  return {
    repository: {
      ...harness.repository,
      transitionProcess: (input) => {
        attempts += 1;
        if (remaining > 0) {
          remaining -= 1;
          return Effect.fail(
            new DatabaseError({ operation: 'transition_pty_process', cause: 'locked' }),
          );
        }
        return harness.repository.transitionProcess(input);
      },
    },
    attempts: () => attempts,
  };
}

test('a deferred killed write still reports terminated_live and keeps the row reserved', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const failing = repositoryFailingWrites(harness, 1);

      const outcome = yield* terminate(harness, backendStub('node_pty'), failing.repository);

      // The kill really happened; only its write is deferred. Reporting failure
      // here would lose a demonstrable termination to a database hiccup.
      assert.equal(outcome, 'terminated_live');
      const termination = harness.terminations.get(harness.ptyProcessId);
      assert.equal(termination?.ownership, 'retry');
      assert.equal(harness.terminations.size, 1);
      // Nothing durable yet, and nothing announced.
      const row = yield* harness.repository.findProcess(harness.ptyProcessId);
      assert.equal(row?.status, 'running');
      assert.deepEqual(harness.bus.events, []);
      assert.equal(harness.retry.pendingCount(), 1);
    }),
  );
});

test('a retried killed write lands, releases the reservation, and stops retrying', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const failing = repositoryFailingWrites(harness, 1);
      yield* terminate(harness, backendStub('node_pty'), failing.repository);

      yield* harness.retry.runPending;

      const row = yield* harness.repository.findProcess(harness.ptyProcessId);
      assert.equal(row?.status, 'killed');
      assert.equal(row?.statusReason, 'user_requested');
      assert.equal(harness.bus.events.length, 1);
      assert.equal(harness.bus.events[0]?.type, 'pty_process_killed');
      // Settled: the row is no longer reserved and no further work is queued.
      assert.equal(harness.terminations.size, 0);
      assert.equal(harness.retry.pendingCount(), 0);
      assert.equal(failing.attempts(), 2);
    }),
  );
});

test('a retried killed write rejected by a terminal row releases the reservation and announces nothing', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const failing = repositoryFailingWrites(harness, 1);
      yield* terminate(harness, backendStub('node_pty'), failing.repository);

      // The real exit landed first while the kill's write was deferred. A
      // rejection is a resolution: retrying it forever would hold the row
      // reserved against a fact that is already final.
      yield* harness.repository.transitionProcess({
        ptyProcessId: harness.ptyProcessId,
        status: 'exited',
        exitCode: 0,
      });

      yield* harness.retry.runPending;

      const row = yield* harness.repository.findProcess(harness.ptyProcessId);
      assert.equal(row?.status, 'exited');
      assert.deepEqual(harness.bus.events, []);
      assert.equal(harness.terminations.size, 0);
      assert.equal(harness.retry.pendingCount(), 0);
    }),
  );
});

test('a deferred captured-exit write keeps the row reserved until the retry lands it', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const failing = repositoryFailingWrites(harness, 1);
      const backend = backendStub('node_pty', {
        // No affirmative kill, but the process exited on its own during the
        // attempt: independent evidence whose write is now deferred.
        kill: () =>
          handleExit(
            harness.repository,
            harness.bus.service,
            harness.retry,
            harness.activeAttachments,
            harness.terminations,
            harness.ptyProcessId,
            { exitCode: 0, signal: null },
          ).pipe(Effect.as({ terminated: false })),
      });

      const outcome = yield* terminate(harness, backend, failing.repository);

      assert.equal(outcome, 'already_absent');
      // Held: an unreserved window here would let the poller land a permanent
      // `backend_process_missing` over a clean exit.
      assert.equal(harness.terminations.get(harness.ptyProcessId)?.ownership, 'retry');
      assert.equal(harness.bus.events.length, 0);

      yield* harness.retry.runPending;

      const row = yield* harness.repository.findProcess(harness.ptyProcessId);
      assert.equal(row?.status, 'exited');
      assert.equal(harness.bus.events.length, 1);
      assert.equal(harness.bus.events[0]?.type, 'pty_process_exited');
      assert.equal(harness.terminations.size, 0);
      assert.equal(harness.retry.pendingCount(), 0);
    }),
  );
});

test('a captured-exit retry keeps trying until it settles', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const failing = repositoryFailingWrites(harness, 2);
      const backend = backendStub('node_pty', {
        kill: () =>
          handleExit(
            harness.repository,
            harness.bus.service,
            harness.retry,
            harness.activeAttachments,
            harness.terminations,
            harness.ptyProcessId,
            { exitCode: 0, signal: null },
          ).pipe(Effect.as({ terminated: false })),
      });

      yield* terminate(harness, backend, failing.repository);

      yield* harness.retry.runPending;
      // Still unresolved after a failed retry: the reservation and the work both
      // survive rather than the write being dropped.
      assert.equal(harness.terminations.get(harness.ptyProcessId)?.ownership, 'retry');
      assert.equal(harness.retry.pendingCount(), 1);

      yield* harness.retry.runPending;

      const row = yield* harness.repository.findProcess(harness.ptyProcessId);
      assert.equal(row?.status, 'exited');
      assert.equal(harness.terminations.size, 0);
      assert.equal(harness.retry.pendingCount(), 0);
    }),
  );
});

test('a second termination attempt is rejected and never reaches the backend', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      let availabilityProbes = 0;
      let kills = 0;
      const backend = backendStub('node_pty', {
        available: Effect.sync(() => {
          availabilityProbes += 1;
          return true;
        }),
        kill: () =>
          Effect.gen(function* () {
            kills += 1;
            // Hold the reservation open so the second call is genuinely concurrent.
            return yield* Effect.never;
          }),
      });

      const first = yield* Effect.fork(terminate(harness, backend));
      yield* Effect.yieldNow();

      const second = yield* terminate(harness, backend).pipe(Effect.either);
      yield* Fiber.interrupt(first);

      assert.equal(Either.isLeft(second), true);
      assert.ok(Either.isLeft(second) && second.left instanceof PtyTerminationInProgressError);
      // Rejected before decode, availability, detach, and the backend — the loser
      // must not be handed the winner's affirmative result either.
      assert.equal(availabilityProbes, 1);
      assert.equal(kills, 1);
    }),
  );
});

test('interrupting a termination releases its reservation instead of stranding the row', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const backend = backendStub('node_pty', {
        // Cancellation reaches an ordinary request through the availability probe
        // and the backend call; neither has produced an affirmative result yet.
        available: Effect.never,
      });

      const fiber = yield* Effect.fork(terminate(harness, backend));
      yield* Effect.yieldNow();
      assert.equal(harness.terminations.size, 1);

      yield* Fiber.interrupt(fiber);

      assert.equal(harness.terminations.size, 0);
      const row = yield* harness.repository.findProcess(harness.ptyProcessId);
      assert.equal(row?.status, 'running');
    }),
  );
});

test('a poller pass leaves a reserved row alone instead of assigning it a competing verdict', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const backend = backendStub('node_pty', {
        // The row's process is genuinely gone, so an unreserved poll would land
        // `backend_process_missing` — permanent, under terminal immutability.
        inspect: () => Effect.succeed({ status: 'missing' as const }),
        kill: () => Effect.never,
      });
      const catalog = catalogWith(backend);

      const fiber = yield* Effect.fork(terminate(harness, backend));
      yield* Effect.yieldNow();
      assert.equal(harness.terminations.size, 1);

      yield* reconcilePersistedProcesses(
        harness.repository,
        catalog,
        harness.bus.service,
        { terminations: harness.terminations, launches: new Map() },
        { startup: false },
      );

      const row = yield* harness.repository.findProcess(harness.ptyProcessId);
      assert.equal(row?.status, 'running');
      assert.equal(row?.statusReason, null);
      assert.deepEqual(harness.bus.events, []);

      yield* Fiber.interrupt(fiber);
    }),
  );
});

test('a poller pass still classifies rows no attempt has reserved', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const catalog = catalogWith(
        backendStub('node_pty', { inspect: () => Effect.succeed({ status: 'missing' as const }) }),
      );

      yield* reconcilePersistedProcesses(
        harness.repository,
        catalog,
        harness.bus.service,
        { terminations: harness.terminations, launches: new Map() },
        { startup: false },
      );

      const row = yield* harness.repository.findProcess(harness.ptyProcessId);
      assert.equal(row?.status, 'failed');
      assert.equal(row?.statusReason, 'runtime_ephemeral_lost');
    }),
  );
});

test('terminating an already-terminal incarnation commits nothing false', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      yield* harness.repository.transitionProcess({
        ptyProcessId: harness.ptyProcessId,
        status: 'exited',
        exitCode: 0,
      });

      // The shutdown sweep selects victims by persisted status, so it can reach a
      // row whose process is already gone. `already_absent` is the honest answer.
      const outcome = yield* terminatePtyProcess({
        repository: harness.repository,
        catalog: catalogWith(
          backendStub('node_pty', { kill: () => Effect.succeed({ terminated: false }) }),
        ),
        eventBus: harness.bus.service,
        activeAttachments: harness.activeAttachments,
        terminations: harness.terminations,
        retry: harness.retry,
        ptyProcessId: harness.ptyProcessId,
        reason: 'runtime_shutdown',
      });

      assert.equal(outcome, 'already_absent');
      const row = yield* harness.repository.findProcess(harness.ptyProcessId);
      assert.equal(row?.status, 'exited');
      assert.deepEqual(harness.bus.events, []);
      assert.equal(harness.terminations.size, 0);
    }),
  );
});
