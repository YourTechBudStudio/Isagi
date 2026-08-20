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
