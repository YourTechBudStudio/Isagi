import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import {
  DatabaseError,
  DataDirectory,
  RuntimeDatabase,
  RuntimeDatabaseLive,
  type RuntimeDatabaseService,
  type RuntimeDrizzleDatabase,
} from '../../persistence/index.js';
import {
  projects,
  ptyProcesses,
  worktreeCommandRuns,
  worktreeCommandStates,
  worktrees,
} from '../../persistence/schema.js';
import { makeTestDataDirectory } from '../../persistence/test-support.js';
import {
  CommandRepository,
  CommandRepositoryLive,
  type CommandRepositoryService,
} from '../commands.repository.js';

/**
 * The atomic finalizers are the only place where a command's run history and its
 * durable entity status move together, and "together" is a property of the real
 * SQLite transaction — an in-memory fake can model the guards but cannot prove
 * the rollback. So these run against the live repository over a throwaway
 * database, and the fault tests inject their failure *inside* the transaction
 * body by refusing a write to a specific table, which is a genuine rollback
 * rather than an assertion about call counts.
 */

const timestamp = '2026-06-19T00:00:00.000Z';

type TableFault = 'runs' | 'states' | null;

function testLayer(dataRoot: string, fault: TableFault) {
  const dataDirectoryLayer = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const live = RuntimeDatabaseLive.pipe(Layer.provide(dataDirectoryLayer));
  const database = fault === null ? live : faultingDatabase(live, fault);
  const repository = CommandRepositoryLive.pipe(Layer.provide(database));
  return Layer.mergeAll(database, repository);
}

// Wraps the real database so one table's updates throw from inside the
// transaction. Everything else — including the reads and the other table's
// writes — is the genuine implementation.
function faultingDatabase(
  live: Layer.Layer<RuntimeDatabaseService, DatabaseError>,
  fault: 'runs' | 'states',
) {
  const table = fault === 'runs' ? worktreeCommandRuns : worktreeCommandStates;
  return Layer.effect(
    RuntimeDatabase,
    Effect.gen(function* () {
      const inner = yield* RuntimeDatabase;
      return {
        use: inner.use,
        transaction: (operation, run) =>
          inner.transaction(operation, (db) =>
            run(
              new Proxy(db, {
                get(target, property, receiver) {
                  if (property === 'update') {
                    return (candidate: unknown) => {
                      if (candidate === table) {
                        throw new Error(`injected ${fault} write failure`);
                      }
                      return target.update(candidate as never);
                    };
                  }
                  const value = Reflect.get(target, property, receiver) as unknown;
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              }) as RuntimeDrizzleDatabase,
            ),
          ),
      } satisfies RuntimeDatabaseService;
    }),
  ).pipe(Layer.provide(live));
}

function runWithDatabase<A, E>(
  build: Effect.Effect<A, E, RuntimeDatabaseService | CommandRepositoryService>,
  options: { readonly fault?: TableFault | undefined } = {},
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-command-repository-'));
  return Effect.runPromise(
    build.pipe(Effect.provide(testLayer(dataRoot, options.fault ?? null))),
  ).finally(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });
}

// A worktree to hang commands off, plus a PTY row for the pointer/link to name.
// Both tables are foreign keys of the command tables, so neither can be faked.
// `activePtyProcessId`/`ptyProcessId` default to the seeded PTY row; pass null
// for the pointerless / linkless shapes.
function seed(input: {
  readonly stateStatus: 'idle' | 'running' | 'suspended' | 'stopped';
  readonly activePtyProcessId?: number | null | undefined;
  readonly run?:
    | {
        readonly status: 'running' | 'exited' | 'stopped' | 'failed';
        readonly ptyProcessId?: number | null | undefined;
        readonly diagnosticReason?: 'pty_launch_failed' | undefined;
        readonly diagnosticDetail?: string | undefined;
      }
    | undefined;
  readonly commandName?: string | undefined;
}) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_seed', (db) => {
      const project = db
        .insert(projects)
        .values({
          name: 'isagi',
          rootPath: '/repo/isagi',
          status: 'present',
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning({ id: projects.id })
        .get();
      const worktree = db
        .insert(worktrees)
        .values({
          projectId: project.id,
          path: '/repo/isagi',
          createdAt: timestamp,
          updatedAt: timestamp,
          firstSeenAt: timestamp,
        })
        .returning({ id: worktrees.id })
        .get();
      const ptyProcess = db
        .insert(ptyProcesses)
        .values({
          backend: 'node_pty',
          backendRefJson: '{}',
          command: '/bin/sh',
          argsJson: '[]',
          cwd: '/repo/isagi',
          status: 'running',
          logMode: 'backend_file',
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning({ id: ptyProcesses.id })
        .get();
      const commandName = input.commandName ?? 'dev';
      const state = db
        .insert(worktreeCommandStates)
        .values({
          worktreeId: worktree.id,
          commandName,
          status: input.stateStatus,
          activePtyProcessId:
            input.activePtyProcessId === null ? null : (input.activePtyProcessId ?? ptyProcess.id),
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning({ id: worktreeCommandStates.id })
        .get();
      const run = input.run
        ? db
            .insert(worktreeCommandRuns)
            .values({
              worktreeId: worktree.id,
              commandName,
              status: input.run.status,
              ptyProcessId:
                input.run.ptyProcessId === null ? null : (input.run.ptyProcessId ?? ptyProcess.id),
              diagnosticReason: input.run.diagnosticReason ?? null,
              diagnosticDetail: input.run.diagnosticDetail ?? null,
              startedAt: timestamp,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .returning({ id: worktreeCommandRuns.id })
            .get()
        : null;
      return {
        worktreeId: worktree.id,
        commandName,
        ptyProcessId: ptyProcess.id,
        stateId: state.id,
        runId: run?.id ?? null,
      };
    });
  });
}

function readRows(worktreeId: number) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_read', (db) => ({
      state: db
        .select()
        .from(worktreeCommandStates)
        .where(eq(worktreeCommandStates.worktreeId, worktreeId))
        .get(),
      run: db
        .select()
        .from(worktreeCommandRuns)
        .where(eq(worktreeCommandRuns.worktreeId, worktreeId))
        .get(),
    }));
  });
}

test('the pty-keyed finalizer completes the run and clears the pointer that named it', async () => {
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const repository = yield* CommandRepository;
      const seeded = yield* seed({
        stateStatus: 'running',
        run: { status: 'running' },
      });
      const finalized = yield* repository.finalizeRunAndStateByPty({
        worktreeId: seeded.worktreeId,
        commandName: seeded.commandName,
        ptyProcessId: seeded.ptyProcessId,
        runStatus: 'stopped',
        stateStatus: 'stopped',
      });
      return { finalized, rows: yield* readRows(seeded.worktreeId) };
    }),
  );

  assert.equal(result.finalized.runCompleted, true);
  assert.equal(result.finalized.stateTransitioned, true);
  assert.equal(result.rows.run?.status, 'stopped');
  assert.ok(result.rows.run?.completedAt);
  assert.equal(result.rows.state?.status, 'stopped');
  assert.equal(result.rows.state?.activePtyProcessId, null);
});

test('the pty-keyed finalizer may write a state status its run never carries', async () => {
  // The seam Phase 07 mints suspension through: run history stays `stopped`
  // while the entity records the resume intent, in one transaction.
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const repository = yield* CommandRepository;
      const seeded = yield* seed({
        stateStatus: 'running',
        run: { status: 'running' },
      });
      yield* repository.finalizeRunAndStateByPty({
        worktreeId: seeded.worktreeId,
        commandName: seeded.commandName,
        ptyProcessId: seeded.ptyProcessId,
        runStatus: 'stopped',
        stateStatus: 'suspended',
      });
      return yield* readRows(seeded.worktreeId);
    }),
  );

  assert.equal(result.run?.status, 'stopped');
  assert.equal(result.state?.status, 'suspended');
  assert.equal(result.state?.activePtyProcessId, null);
});

test('the pty-keyed finalizer leaves a state pointing at a different incarnation alone', async () => {
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const repository = yield* CommandRepository;
      const seeded = yield* seed({
        stateStatus: 'running',
        run: { status: 'running' },
      });
      const finalized = yield* repository.finalizeRunAndStateByPty({
        worktreeId: seeded.worktreeId,
        commandName: seeded.commandName,
        // A superseded incarnation's late echo: no run of that id, and the
        // pointer names someone else.
        ptyProcessId: seeded.ptyProcessId + 1_000,
        runStatus: 'stopped',
        stateStatus: 'stopped',
      });
      return { finalized, rows: yield* readRows(seeded.worktreeId) };
    }),
  );

  assert.equal(result.finalized.run, null);
  assert.equal(result.finalized.runCompleted, false);
  assert.equal(result.finalized.stateTransitioned, false);
  assert.equal(result.rows.run?.status, 'running');
  assert.equal(result.rows.state?.status, 'running');
});

test('the pty-keyed finalizer repairs a stale pointer even when no run remains', async () => {
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const repository = yield* CommandRepository;
      const seeded = yield* seed({ stateStatus: 'running' });
      const finalized = yield* repository.finalizeRunAndStateByPty({
        worktreeId: seeded.worktreeId,
        commandName: seeded.commandName,
        ptyProcessId: seeded.ptyProcessId,
        runStatus: 'exited',
        stateStatus: 'exited',
      });
      return { finalized, rows: yield* readRows(seeded.worktreeId) };
    }),
  );

  assert.equal(result.finalized.run, null);
  assert.equal(result.finalized.runCompleted, false);
  assert.equal(result.finalized.stateTransitioned, true);
  assert.equal(result.rows.state?.status, 'exited');
  assert.equal(result.rows.state?.activePtyProcessId, null);
});

test('a terminal run keeps its first recorded outcome and diagnostics while the state is repaired', async () => {
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const repository = yield* CommandRepository;
      const seeded = yield* seed({
        stateStatus: 'running',
        run: {
          status: 'failed',
          diagnosticReason: 'pty_launch_failed',
          diagnosticDetail: 'the original reason',
        },
      });
      const finalized = yield* repository.finalizeRunAndStateByPty({
        worktreeId: seeded.worktreeId,
        commandName: seeded.commandName,
        ptyProcessId: seeded.ptyProcessId,
        runStatus: 'stopped',
        stateStatus: 'stopped',
      });
      return { finalized, rows: yield* readRows(seeded.worktreeId) };
    }),
  );

  assert.equal(result.finalized.runCompleted, false);
  assert.equal(result.finalized.stateTransitioned, true);
  assert.equal(result.rows.run?.status, 'failed');
  assert.equal(result.rows.run?.diagnosticReason, 'pty_launch_failed');
  assert.equal(result.rows.run?.diagnosticDetail, 'the original reason');
  assert.equal(result.rows.state?.status, 'stopped');
});

test('the run-keyed finalizer transitions only a state still holding the launch marker', async () => {
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const repository = yield* CommandRepository;
      const seeded = yield* seed({
        stateStatus: 'running',
        // The launch-in-progress marker: `running` with no pointer yet.
        activePtyProcessId: null,
        run: { status: 'running' },
      });
      const finalized = yield* repository.finalizeRunAndStateByRun({
        runId: seeded.runId!,
        worktreeId: seeded.worktreeId,
        commandName: seeded.commandName,
        runStatus: 'failed',
        stateStatus: 'failed',
        diagnosticReason: 'pty_launch_failed',
        diagnosticDetail: 'the launch never started a process',
      });
      return { finalized, rows: yield* readRows(seeded.worktreeId) };
    }),
  );

  assert.equal(result.finalized.runCompleted, true);
  assert.equal(result.finalized.stateTransitioned, true);
  assert.equal(result.rows.run?.diagnosticReason, 'pty_launch_failed');
  assert.equal(result.rows.state?.status, 'failed');
});

test('the run-keyed finalizer leaves a prior entity status untouched before the marker exists', async () => {
  // Pre-marker cancellation: only the run may be completed. A resume's
  // `suspended` intent has to survive for the next activation.
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const repository = yield* CommandRepository;
      const seeded = yield* seed({
        stateStatus: 'suspended',
        activePtyProcessId: null,
        run: { status: 'running' },
      });
      const finalized = yield* repository.finalizeRunAndStateByRun({
        runId: seeded.runId!,
        worktreeId: seeded.worktreeId,
        commandName: seeded.commandName,
        runStatus: 'failed',
        stateStatus: 'failed',
      });
      return { finalized, rows: yield* readRows(seeded.worktreeId) };
    }),
  );

  assert.equal(result.finalized.runCompleted, true);
  assert.equal(result.finalized.stateTransitioned, false);
  assert.equal(result.rows.run?.status, 'failed');
  assert.equal(result.rows.state?.status, 'suspended');
});

test('the run-keyed finalizer refuses a run that belongs to another command', async () => {
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const repository = yield* CommandRepository;
      const seeded = yield* seed({
        stateStatus: 'running',
        // The launch-in-progress marker: `running` with no pointer yet.
        activePtyProcessId: null,
        run: { status: 'running' },
      });
      const finalized = yield* repository.finalizeRunAndStateByRun({
        runId: seeded.runId!,
        worktreeId: seeded.worktreeId,
        commandName: 'a different command',
        runStatus: 'failed',
        stateStatus: 'failed',
      });
      return { finalized, rows: yield* readRows(seeded.worktreeId) };
    }),
  );

  assert.equal(result.finalized.run, null);
  assert.equal(result.finalized.runCompleted, false);
  assert.equal(result.finalized.stateTransitioned, false);
  assert.equal(result.rows.run?.status, 'running');
  assert.equal(result.rows.state?.status, 'running');
});

test('a failed state write rolls the completed run back with it', async () => {
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const repository = yield* CommandRepository;
      const seeded = yield* seed({
        stateStatus: 'running',
        run: { status: 'running' },
      });
      const finalized = yield* repository
        .finalizeRunAndStateByPty({
          worktreeId: seeded.worktreeId,
          commandName: seeded.commandName,
          ptyProcessId: seeded.ptyProcessId,
          runStatus: 'stopped',
          stateStatus: 'suspended',
        })
        .pipe(Effect.either);
      return { finalized, rows: yield* readRows(seeded.worktreeId) };
    }),
    { fault: 'states' },
  );

  assert.equal(result.finalized._tag, 'Left');
  // Nothing partial: the run is not `stopped` under a state that never moved,
  // so a later echo still finds a `running` run to finalize honestly.
  assert.equal(result.rows.run?.status, 'running');
  assert.equal(result.rows.run?.completedAt, null);
  assert.equal(result.rows.state?.status, 'running');
});

test('a failed run write leaves the state alone', async () => {
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const repository = yield* CommandRepository;
      const seeded = yield* seed({
        stateStatus: 'running',
        // The launch-in-progress marker: `running` with no pointer yet.
        activePtyProcessId: null,
        run: { status: 'running' },
      });
      const finalized = yield* repository
        .finalizeRunAndStateByRun({
          runId: seeded.runId!,
          worktreeId: seeded.worktreeId,
          commandName: seeded.commandName,
          runStatus: 'failed',
          stateStatus: 'failed',
        })
        .pipe(Effect.either);
      return { finalized, rows: yield* readRows(seeded.worktreeId) };
    }),
    { fault: 'runs' },
  );

  assert.equal(result.finalized._tag, 'Left');
  assert.equal(result.rows.run?.status, 'running');
  assert.equal(result.rows.state?.status, 'running');
  assert.equal(result.rows.state?.activePtyProcessId, null);
});

test('re-adoption rebinds the pointer, reopens the retained run, and records the diagnostic', async () => {
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const repository = yield* CommandRepository;
      // A command recorded as finished over an incarnation that turns out to be
      // alive: the live process is what disproves the recorded completion.
      const seeded = yield* seed({
        stateStatus: 'stopped',
        activePtyProcessId: null,
        run: { status: 'stopped', ptyProcessId: null },
      });
      const readopted = yield* repository.readoptCommandIncarnation({
        worktreeId: seeded.worktreeId,
        commandName: seeded.commandName,
        ptyProcessId: seeded.ptyProcessId,
        diagnostic: { reason: 'process_control_failed', detail: 'could not verify' },
      });
      const rows = yield* readRows(seeded.worktreeId);
      return { seeded, readopted, rows };
    }),
  );

  assert.equal(result.rows.state?.status, 'running');
  assert.equal(result.rows.state?.activePtyProcessId, result.seeded.ptyProcessId);
  assert.equal(result.rows.run?.id, result.seeded.runId);
  assert.equal(result.rows.run?.status, 'running');
  assert.equal(result.rows.run?.ptyProcessId, result.seeded.ptyProcessId);
  assert.equal(result.rows.run?.completedAt, null);
  assert.equal(result.rows.run?.diagnosticReason, 'process_control_failed');
  assert.equal(result.rows.run?.diagnosticDetail, 'could not verify');
});

test('re-adoption inserts a run when the command has none to reopen', async () => {
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const repository = yield* CommandRepository;
      const seeded = yield* seed({ stateStatus: 'stopped', activePtyProcessId: null });
      yield* repository.readoptCommandIncarnation({
        worktreeId: seeded.worktreeId,
        commandName: seeded.commandName,
        ptyProcessId: seeded.ptyProcessId,
        diagnostic: { reason: 'process_control_failed', detail: null },
      });
      const rows = yield* readRows(seeded.worktreeId);
      return { seeded, rows };
    }),
  );

  assert.equal(result.rows.run?.status, 'running');
  assert.equal(result.rows.run?.ptyProcessId, result.seeded.ptyProcessId);
  assert.equal(result.rows.run?.diagnosticReason, 'process_control_failed');
});

test('a failed run write rolls the re-adopted state back with it', async () => {
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const repository = yield* CommandRepository;
      const seeded = yield* seed({
        stateStatus: 'stopped',
        activePtyProcessId: null,
        run: { status: 'stopped', ptyProcessId: null },
      });
      const outcome = yield* repository
        .readoptCommandIncarnation({
          worktreeId: seeded.worktreeId,
          commandName: seeded.commandName,
          ptyProcessId: seeded.ptyProcessId,
          diagnostic: { reason: 'process_control_failed', detail: null },
        })
        .pipe(Effect.either);
      const rows = yield* readRows(seeded.worktreeId);
      return { outcome, rows };
    }),
    { fault: 'runs' },
  );

  assert.equal(result.outcome._tag, 'Left');
  // Ownership is never half-repaired: the state write went first and was undone.
  assert.equal(result.rows.state?.status, 'stopped');
  assert.equal(result.rows.state?.activePtyProcessId, null);
  assert.equal(result.rows.run?.status, 'stopped');
});

test('re-adoption without a diagnostic repairs ownership and preserves the recorded one', async () => {
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const repository = yield* CommandRepository;
      // The run already explains why this command is in trouble. Re-adopting
      // ownership is not a reason to destroy that explanation, so the
      // conditional update must not name the diagnostic columns at all.
      const seeded = yield* seed({
        stateStatus: 'stopped',
        activePtyProcessId: null,
        run: {
          status: 'failed',
          ptyProcessId: null,
          diagnosticReason: 'pty_launch_failed',
          diagnosticDetail: 'earlier evidence',
        },
      });
      yield* repository.readoptCommandIncarnation({
        worktreeId: seeded.worktreeId,
        commandName: seeded.commandName,
        ptyProcessId: seeded.ptyProcessId,
      });
      const rows = yield* readRows(seeded.worktreeId);
      return { seeded, rows };
    }),
  );

  // Ownership repaired…
  assert.equal(result.rows.state?.status, 'running');
  assert.equal(result.rows.state?.activePtyProcessId, result.seeded.ptyProcessId);
  assert.equal(result.rows.run?.status, 'running');
  assert.equal(result.rows.run?.ptyProcessId, result.seeded.ptyProcessId);
  assert.equal(result.rows.run?.completedAt, null);
  // …and both diagnostic columns left exactly as they were.
  assert.equal(result.rows.run?.diagnosticReason, 'pty_launch_failed');
  assert.equal(result.rows.run?.diagnosticDetail, 'earlier evidence');
});

/**
 * The resolved-port snapshot's keep-versus-replace contract.
 *
 * This is the mechanism the whole allocation-memory design rests on: the launch
 * marker is the *only* write, and every other transition preserves the column by
 * simply not naming it. Proving that here means later lifecycle work — stop,
 * suspend, exit, convergence, boot repair — inherits the guarantee without
 * having to restate it at each call site.
 */

const snapshot = [
  { envVar: 'API_PORT', port: 5173, paths: [{ label: 'api', path: '/api' }] },
] as const;

test('a transition after the marker cannot touch the stored snapshot', async () => {
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const repository = yield* CommandRepository;
      const seeded = yield* seed({ stateStatus: 'running' });
      yield* repository.markLaunchInProgress({
        worktreeId: seeded.worktreeId,
        commandName: seeded.commandName,
        resolvedPorts: snapshot,
      });
      // A stop, exactly as the stop path writes it — and now the only shape it
      // *can* write: `transitionState` has no access to the snapshot column at
      // all, so preservation is a property of the interface rather than of this
      // caller remembering to omit a field.
      const stopped = yield* repository.transitionState({
        worktreeId: seeded.worktreeId,
        commandName: seeded.commandName,
        status: 'stopped',
        activePtyProcessId: null,
      });
      return stopped;
    }),
  );

  assert.equal(result.status, 'stopped');
  assert.deepEqual(result.resolvedPorts, snapshot);
});

test('a later marker replaces the stored snapshot, empty included', async () => {
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const repository = yield* CommandRepository;
      const seeded = yield* seed({ stateStatus: 'running' });
      yield* repository.markLaunchInProgress({
        worktreeId: seeded.worktreeId,
        commandName: seeded.commandName,
        resolvedPorts: snapshot,
      });
      // Removing every port declaration and launching again forgets the
      // allocation — but only at the next successful launch, never before.
      return yield* repository.markLaunchInProgress({
        worktreeId: seeded.worktreeId,
        commandName: seeded.commandName,
        resolvedPorts: [],
      });
    }),
  );

  assert.deepEqual(result.resolvedPorts, []);
});

test('a state row inserted by the marker carries the snapshot it was given', async () => {
  // The first launch of a command whose state row does not exist yet takes the
  // insert branch; losing the snapshot there would break memory from launch one.
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const repository = yield* CommandRepository;
      const seeded = yield* seed({ stateStatus: 'idle' });
      return yield* repository.markLaunchInProgress({
        worktreeId: seeded.worktreeId,
        commandName: 'never seen',
        resolvedPorts: snapshot,
      });
    }),
  );

  assert.deepEqual(result.resolvedPorts, snapshot);
});

test('a state row with no snapshot reads as null', async () => {
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const repository = yield* CommandRepository;
      const seeded = yield* seed({ stateStatus: 'running' });
      return yield* repository.findState({
        worktreeId: seeded.worktreeId,
        commandName: seeded.commandName,
      });
    }),
  );

  assert.equal(result?.resolvedPorts, null);
});

test('a malformed stored snapshot decodes to null rather than failing the read', async () => {
  // Out-of-model data degrades to the value the contract already means by
  // "unknown for this incarnation". A read that threw here would take the whole
  // command drawer down over one bad row.
  const result = await runWithDatabase(
    Effect.gen(function* () {
      const repository = yield* CommandRepository;
      const database = yield* RuntimeDatabase;
      const seeded = yield* seed({ stateStatus: 'running' });
      yield* database.use('test_corrupt', (db) =>
        db
          .update(worktreeCommandStates)
          .set({ resolvedPortsJson: '{"not":"an array"}' })
          .where(eq(worktreeCommandStates.id, seeded.stateId))
          .run(),
      );
      return yield* repository.findState({
        worktreeId: seeded.worktreeId,
        commandName: seeded.commandName,
      });
    }),
  );

  assert.equal(result?.status, 'running');
  assert.equal(result?.resolvedPorts, null);
});

test('a resolved snapshot survives closing and reopening the database', async () => {
  // The other snapshot tests exercise the real column inside one layer lifetime,
  // which proves keep-versus-replace but not durability: they never close
  // anything. Allocation memory's whole promise is that it outlives the runtime
  // process, so this test tears the layer down and builds a second one over the
  // same files — the closest a unit test gets to restarting Isagi.
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-command-reopen-'));
  const durableSnapshot = [
    { envVar: null, port: 5173, paths: [{ label: 'app', path: '/' }] },
    { envVar: 'API_PORT', port: 51824, paths: [] },
  ] as const;

  try {
    const withFreshLayer = <A, E>(
      build: Effect.Effect<A, E, RuntimeDatabaseService | CommandRepositoryService>,
    ) => Effect.runPromise(build.pipe(Effect.provide(testLayer(dataRoot, null))));

    const worktreeId = await withFreshLayer(
      Effect.gen(function* () {
        const ids = yield* seed({ stateStatus: 'idle' });
        const repository = yield* CommandRepository;
        yield* repository.markLaunchInProgress({
          worktreeId: ids.worktreeId,
          commandName: ids.commandName,
          resolvedPorts: durableSnapshot,
        });
        return ids.worktreeId;
      }),
    );

    // A second, independent layer: new database handle, new repository, same
    // files on disk.
    const reopened = await withFreshLayer(
      Effect.gen(function* () {
        const repository = yield* CommandRepository;
        return yield* repository.findState({ worktreeId, commandName: 'dev' });
      }),
    );

    assert.deepEqual(reopened?.resolvedPorts, durableSnapshot);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
