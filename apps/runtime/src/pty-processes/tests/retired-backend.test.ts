import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Cause, Effect, Exit, FiberMap, Layer, Stream } from 'effect';

import type {
  PtyProcessBackend,
  PtyProcessLogMode,
  PtyStreamOutputMessageSet,
} from '@isagi/shared/contracts';

import { CliAccessNone } from '../../cli-access/testing.js';
import { InternalEvents } from '../../platform/events/index.js';
import { DataDirectory, RuntimeDatabase } from '../../platform/persistence/index.js';
import { makeTestDataDirectory } from '../../platform/persistence/testing.js';
import { testUserShellLayer } from '../../platform/process/testing.js';
import { PtyBackendCatalog } from '../backend.js';
import { PtyForegroundState } from '../foreground-state.js';
import { LaunchEnvironment } from '../launch-environment.js';
import { PtyRepository } from '../repository.js';
import { PtyService, reconcilePersistedProcesses } from '../service.js';
import { decodeBackendRef } from '../service/backend-ref.js';
import { collectPtyGarbage } from '../service/gc.js';
import { reserveLaunch, type PtyReservations } from '../service/lifecycle.js';
import { ptyProcesses } from '../tables.js';
import { fakeBackendCatalog, ptyTestRuntimeConfig } from '../testing.js';
import {
  interruptedByRuntime,
  type PtyBackend as PtyBackendShape,
  type PtyProcessStatus,
} from '../types.js';

// `tmux` is a retired persisted backend: a row written by an older runtime may
// still carry it, but no adapter exists for it. These tests pin how such rows
// behave, and that nothing ever routes one to the node-pty adapter.

const tmuxRef = (id: number) =>
  JSON.stringify({ schemaVersion: 1, backend: 'tmux', sessionName: `isagi_test_${id}` });
const nodePtyRef = (id: number) =>
  JSON.stringify({ schemaVersion: 1, backend: 'node_pty', ptyProcessId: id, pid: 4242 });

function backendStub(overrides: Partial<PtyBackendShape> = {}) {
  return {
    name: 'node_pty',
    available: Effect.succeed(true),
    launch: () => Effect.die('launch is not expected here'),
    writeInput: () => Effect.void,
    attach: () => Effect.die('attach is not expected here'),
    replay: () => Effect.void,
    inspect: () => Effect.succeed({ status: 'alive' as const }),
    listSessions: Effect.succeed([]),
    kill: () => Effect.succeed({ terminated: true }),
    ...overrides,
  } satisfies PtyBackendShape;
}

// The only adapter, forbidden from touching anything: any call through it would
// be a retired row routed to the wrong transport.
function forbiddenNodePty() {
  return backendStub({
    available: Effect.die('node-pty must never be probed for a retired row'),
    inspect: () => Effect.die('node-pty must never inspect a retired row'),
    kill: () => Effect.die('node-pty must never kill a retired row'),
    replay: () => Effect.die('node-pty must never replay a retired row'),
  });
}

function persistenceLayer(dataRoot: string) {
  const directory = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabase.layer.pipe(Layer.provide(directory));
  return Layer.mergeAll(database, PtyRepository.layer.pipe(Layer.provide(database)));
}

function serviceLayer(dataRoot: string, nodePty: PtyBackendShape) {
  const directory = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabase.layer.pipe(Layer.provide(directory));
  const repository = PtyRepository.layer.pipe(Layer.provide(database));
  const service = PtyService.layerNoDeps.pipe(
    Layer.provide(LaunchEnvironment.layerNoDeps),
    Layer.provide(ptyTestRuntimeConfig()),
    Layer.provide(CliAccessNone),
    Layer.provide(repository),
    Layer.provide(Layer.succeed(PtyBackendCatalog, fakeBackendCatalog({ nodePty }))),
    Layer.provide(PtyForegroundState.layer),
    Layer.provide(directory),
    Layer.provide(InternalEvents.layer),
    Layer.provide(testUserShellLayer()),
  );
  return Layer.mergeAll(database, repository, service);
}

function seedRow(input: {
  readonly backend: PtyProcessBackend;
  readonly status: PtyProcessStatus;
  readonly backendRefJson?: (id: number) => string;
  readonly logMode?: PtyProcessLogMode;
}) {
  return Effect.gen(function* () {
    const repository = yield* PtyRepository;
    const id = yield* repository.createProcessMetadata({
      command: 'pnpm',
      args: ['dev'],
      cwd: '/repo/isagi',
    });
    yield* repository.updateBackendMetadata({
      ptyProcessId: id,
      backend: input.backend,
      backendRefJson: (
        input.backendRefJson ?? (input.backend === 'node_pty' ? nodePtyRef : tmuxRef)
      )(id),
      logMode: input.logMode ?? 'none',
      logPath: null,
    });
    if (input.status !== 'starting') {
      yield* repository.transitionProcess({
        ptyProcessId: id,
        status: input.status,
        statusReason: input.status === 'killed' ? 'user_requested' : null,
      });
    }
    return id;
  });
}

async function withTempRoot(label: string, run: (dataRoot: string) => Promise<void>) {
  const dataRoot = mkdtempSync(join(tmpdir(), `isagi-pty-retired-${label}-`));
  try {
    await run(dataRoot);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

function emptyReservations(): PtyReservations {
  return { terminations: new Map(), launches: new Map() };
}

// Reconciliation over the persisted rows, outside a service, so a test can hold
// reservations and choose startup or periodic semantics.
function reconcile(
  dataRoot: string,
  input: { readonly startup: boolean; readonly reservations?: PtyReservations },
  nodePty: PtyBackendShape = forbiddenNodePty(),
) {
  return Effect.gen(function* () {
    const repository = yield* PtyRepository;
    const bus = yield* InternalEvents;
    yield* reconcilePersistedProcesses(
      repository,
      fakeBackendCatalog({ nodePty }),
      bus,
      input.reservations ?? emptyReservations(),
      { supervisors: yield* FiberMap.make<number, void, never>(), deferredWrites: new Set() },
      { startup: input.startup },
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(persistenceLayer(dataRoot), InternalEvents.layer)),
  );
}

function findRow(dataRoot: string, ptyProcessId: number) {
  return Effect.gen(function* () {
    return yield* (yield* PtyRepository).findProcess(ptyProcessId);
  }).pipe(Effect.provide(persistenceLayer(dataRoot)));
}

test('startup records a live tmux row as lost with the runtime, so its owner relaunches it', () =>
  withTempRoot('startup', async (dataRoot) => {
    const ids = await Effect.runPromise(
      Effect.all([
        seedRow({ backend: 'tmux', status: 'running' }),
        seedRow({ backend: 'tmux', status: 'starting' }),
      ]).pipe(Effect.provide(persistenceLayer(dataRoot))),
    );

    // Building the service runs startup reconciliation, exactly as after an upgrade.
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        yield* PtyService;
        const repository = yield* PtyRepository;
        return yield* Effect.forEach(ids, (id) => repository.findProcess(id));
      }).pipe(Effect.provide(serviceLayer(dataRoot, forbiddenNodePty()))),
    );

    for (const row of rows) {
      assert.equal(row?.status, 'failed');
      assert.equal(row?.statusReason, 'runtime_ephemeral_lost');
      // ADR 0012: an interruption, not an outcome.
      assert.ok(row && interruptedByRuntime(row));
    }
  }));

test('startup leaves a reserved live tmux row to the attempt that owns it', () =>
  withTempRoot('startup-reserved', async (dataRoot) => {
    const id = await Effect.runPromise(
      seedRow({ backend: 'tmux', status: 'running' }).pipe(
        Effect.provide(persistenceLayer(dataRoot)),
      ),
    );
    const reservations = emptyReservations();
    reserveLaunch(reservations.launches, id);

    await Effect.runPromise(reconcile(dataRoot, { startup: true, reservations }));

    const row = await Effect.runPromise(findRow(dataRoot, id));
    assert.equal(row?.status, 'running');
    assert.equal(row?.statusReason, null);
  }));

test('periodic reconciliation terminalizes a live retired row and keeps polling', () =>
  withTempRoot('periodic', async (dataRoot) => {
    const ids = await Effect.runPromise(
      Effect.all({
        tmux: seedRow({ backend: 'tmux', status: 'running' }),
        // Seeded after the retired row, so the pass must survive it to reach this one.
        nodePty: seedRow({ backend: 'node_pty', status: 'running' }),
      }).pipe(Effect.provide(persistenceLayer(dataRoot))),
    );
    let inspected: number[] = [];

    await Effect.runPromise(
      reconcile(
        dataRoot,
        { startup: false },
        backendStub({
          inspect: (ref) =>
            Effect.sync(() => {
              inspected.push(ref.ptyProcessId);
              return { status: 'alive' as const };
            }),
        }),
      ),
    );

    // Only reachable through corruption after startup. Its ref does not decode,
    // so it takes the existing undecodable-ref path without probing anything.
    const tmux = await Effect.runPromise(findRow(dataRoot, ids.tmux));
    assert.equal(tmux?.status, 'failed');
    assert.equal(tmux?.statusReason, 'backend_process_missing');
    assert.deepEqual(inspected, [ids.nodePty]);
    const nodePty = await Effect.runPromise(findRow(dataRoot, ids.nodePty));
    assert.equal(nodePty?.status, 'running');
  }));

test('a terminal tmux row replays empty', () =>
  withTempRoot('replay', async (dataRoot) => {
    const id = await Effect.runPromise(
      seedRow({ backend: 'tmux', status: 'exited', logMode: 'none' }).pipe(
        Effect.provide(persistenceLayer(dataRoot)),
      ),
    );
    const sent: PtyStreamOutputMessageSet[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const pty = yield* PtyService;
        const session = yield* (yield* PtyRepository).findProcess(id);
        assert.ok(session);
        yield* pty.replay({ session, bytes: null, send: (message) => sent.push(message) });
      }).pipe(Effect.provide(serviceLayer(dataRoot, forbiddenNodePty()))),
    );

    assert.deepEqual(sent, [{ type: 'replay_start', bytes: 0 }, { type: 'replay_end' }]);
  }));

test('ensuring absence behind a terminal tmux row finds nothing this runtime could own', () =>
  withTempRoot('cleanup', async (dataRoot) => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const pty = yield* PtyService;
        // Seeded inside the built service with a ref no schema accepts, so the
        // outcome cannot come from decoding or resolving anything.
        const ptyProcessId = yield* seedRow({
          backend: 'tmux',
          status: 'exited',
          backendRefJson: () => '{"not":"a ref"}',
        });
        return yield* pty.cleanupProcess({
          ptyProcessId,
          reason: 'user_requested',
          ensureBackendAbsence: true,
        });
      }).pipe(Effect.provide(serviceLayer(dataRoot, forbiddenNodePty()))),
    );

    assert.equal(outcome, 'already_terminal');
  }));

test('GC deletes an orphan terminal tmux row like any other ended process', () =>
  withTempRoot('gc', async (dataRoot) => {
    const sessionsPath = join(dataRoot, 'sessions');
    mkdirSync(sessionsPath, { recursive: true });
    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const database = yield* RuntimeDatabase;
        const id = yield* seedRow({ backend: 'tmux', status: 'killed' });
        yield* database.use('age_pty_process_for_gc_test', (db) => {
          db.update(ptyProcesses)
            .set({ updatedAt: new Date(0).toISOString() })
            .where(eq(ptyProcesses.id, id))
            .run();
        });
        yield* collectPtyGarbage(
          repository,
          fakeBackendCatalog({ nodePty: forbiddenNodePty() }),
          'test-runtime',
          sessionsPath,
          { nowMs: Date.now() },
        );
        return yield* repository.findProcess(id);
      }).pipe(Effect.provide(persistenceLayer(dataRoot))),
    );

    assert.equal(row, null);
  }));

test('a tmux row has no operable backend ref', async () => {
  for (const backendRefJson of [tmuxRef(801), nodePtyRef(801)]) {
    const error = await Effect.runPromise(
      Effect.flip(decodeBackendRef({ id: 801, backend: 'tmux', backendRefJson } as never)),
    );
    assert.equal(error.code, 'backend_session_missing');
  }
});

test('an unknown persisted backend is still a defect, not a retired row', () =>
  withTempRoot('unknown', async (dataRoot) => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const pty = yield* PtyService;
        const ptyProcessId = yield* seedRow({
          backend: 'screen' as never,
          status: 'exited',
          backendRefJson: nodePtyRef,
        });
        return yield* pty.cleanupProcess({
          ptyProcessId,
          reason: 'user_requested',
          ensureBackendAbsence: true,
        });
      }).pipe(Effect.provide(serviceLayer(dataRoot, forbiddenNodePty()))),
    );

    assert.ok(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
    assert.match(String(Cause.squash(exit.cause)), /Unknown persisted PTY backend screen/);
  }));

test('shutdown still terminates every other live row when a corrupt live tmux row is present', () =>
  withTempRoot('shutdown', async (dataRoot) => {
    const killed: number[] = [];
    const ids = await Effect.runPromise(
      Effect.gen(function* () {
        yield* PtyService;
        // Both seeded after startup reconciliation: a live tmux row now can only
        // be corruption.
        return {
          tmux: yield* seedRow({ backend: 'tmux', status: 'running' }),
          nodePty: yield* seedRow({ backend: 'node_pty', status: 'running' }),
        };
      }).pipe(
        Effect.provide(
          serviceLayer(
            dataRoot,
            backendStub({
              kill: (ref) =>
                Effect.sync(() => {
                  killed.push(ref.ptyProcessId);
                  return { terminated: true };
                }),
            }),
          ),
        ),
      ),
    );

    assert.deepEqual(killed, [ids.nodePty]);
    const nodePty = await Effect.runPromise(findRow(dataRoot, ids.nodePty));
    assert.equal(nodePty?.status, 'killed');
    assert.equal(nodePty?.statusReason, 'runtime_shutdown');
    // Its ref does not decode, so termination failed before reaching any
    // adapter, and the row is left for the next startup to classify.
    const tmux = await Effect.runPromise(findRow(dataRoot, ids.tmux));
    assert.equal(tmux?.status, 'running');
  }));

// ---------------------------------------------------------------------------
// The one registered adapter
// ---------------------------------------------------------------------------

test('a launch uses the configured node-pty adapter and keeps a file log', () =>
  withTempRoot('launch', async (dataRoot) => {
    let launches = 0;
    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const pty = yield* PtyService;
        const metadata = yield* pty.launch({ command: 'pnpm', args: ['dev'], cwd: '/repo/isagi' });
        return yield* (yield* PtyRepository).findProcess(metadata.ptyProcessId);
      }).pipe(
        Effect.provide(
          serviceLayer(
            dataRoot,
            backendStub({
              launch: (input) =>
                Effect.sync(() => {
                  launches += 1;
                  return {
                    ref: {
                      schemaVersion: 1 as const,
                      backend: 'node_pty' as const,
                      ptyProcessId: input.ptyProcessId,
                      pid: 4242,
                    },
                    events: Stream.empty,
                  };
                }),
            }),
          ),
        ),
      ),
    );

    assert.equal(launches, 1);
    assert.equal(row?.backend, 'node_pty');
    assert.equal(row?.logMode, 'backend_file');
    assert.ok(row?.logPath);
  }));

test('the backend-session sweep runs the registered adapter and skips it when unavailable', () =>
  withTempRoot('sweep', async (dataRoot) => {
    for (const available of [true, false]) {
      let swept = 0;
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* PtyService;
        }).pipe(
          Effect.provide(
            serviceLayer(
              dataRoot,
              backendStub({
                available: Effect.succeed(available),
                collectGarbage: () =>
                  Effect.sync(() => {
                    swept += 1;
                    return [];
                  }),
              }),
            ),
          ),
        ),
      );
      assert.equal(swept, available ? 1 : 0);
    }
  }));
