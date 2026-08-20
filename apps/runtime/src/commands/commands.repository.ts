import { and, desc, eq, getTableColumns, inArray, type InferSelectModel } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type { CommandRunDiagnosticReason, CommandRunStatus, CommandStatus } from '@isagi/contracts';

import {
  DatabaseError,
  RuntimeDatabase,
  type RuntimeDrizzleDatabase,
} from '../persistence/index.js';
import { worktreeCommandRuns, worktreeCommandStates } from '../persistence/schema.js';

type CommandStateRecord = InferSelectModel<typeof worktreeCommandStates>;
type CommandRunRecord = InferSelectModel<typeof worktreeCommandRuns>;

export interface CommandStateRow {
  readonly id: number;
  readonly worktreeId: number;
  readonly commandName: string;
  readonly status: CommandStatus;
  readonly activePtyProcessId: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CommandRunRow {
  readonly id: number;
  readonly worktreeId: number;
  readonly commandName: string;
  readonly ptyProcessId: number | null;
  readonly status: CommandRunStatus;
  readonly diagnosticReason: CommandRunDiagnosticReason | null;
  readonly diagnosticDetail: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// The shared result of both atomic finalizers. `runCompleted` and
// `stateTransitioned` report what this call actually changed, so the service can
// publish only real transitions instead of re-announcing a status a late echo
// merely observed. The two are independent decisions inside one transaction: a
// state pointer can be repaired even when no run row remains to complete.
export interface CommandFinalizeResult {
  // The targeted run after the transaction; null when no run matched.
  readonly run: CommandRunRow | null;
  // True only when this call moved that run out of `running`.
  readonly runCompleted: boolean;
  // True only when this call moved the state row.
  readonly stateTransitioned: boolean;
  readonly state: CommandStateRow | null;
}

export interface CommandRepositoryService {
  readonly listStatesForWorktree: (
    worktreeId: number,
  ) => Effect.Effect<CommandStateRow[], DatabaseError>;
  readonly findState: (input: {
    readonly worktreeId: number;
    readonly commandName: string;
  }) => Effect.Effect<CommandStateRow | null, DatabaseError>;
  readonly listRunningStates: Effect.Effect<CommandStateRow[], DatabaseError>;
  readonly listRunningStatesForWorktree: (
    worktreeId: number,
  ) => Effect.Effect<CommandStateRow[], DatabaseError>;
  readonly ensureState: (input: {
    readonly worktreeId: number;
    readonly commandName: string;
    readonly status?: CommandStatus | undefined;
    readonly activePtyProcessId?: number | null | undefined;
  }) => Effect.Effect<CommandStateRow, DatabaseError>;
  readonly transitionState: (input: {
    readonly worktreeId: number;
    readonly commandName: string;
    readonly status: CommandStatus;
    readonly activePtyProcessId?: number | null | undefined;
  }) => Effect.Effect<CommandStateRow, DatabaseError>;
  readonly createRun: (input: {
    readonly worktreeId: number;
    readonly commandName: string;
    readonly status: CommandRunStatus;
    readonly ptyProcessId?: number | null | undefined;
    readonly diagnosticReason?: CommandRunDiagnosticReason | null | undefined;
    readonly diagnosticDetail?: string | null | undefined;
    readonly completedAt?: string | null | undefined;
  }) => Effect.Effect<CommandRunRow, DatabaseError>;
  readonly updateRunPty: (input: {
    readonly runId: number;
    readonly ptyProcessId: number;
  }) => Effect.Effect<CommandRunRow | null, DatabaseError>;
  readonly completeRun: (input: {
    readonly runId: number;
    readonly status: Exclude<CommandRunStatus, 'running'>;
    readonly diagnosticReason?: CommandRunDiagnosticReason | null | undefined;
    readonly diagnosticDetail?: string | null | undefined;
  }) => Effect.Effect<CommandRunRow | null, DatabaseError>;
  // Event-driven finalization — stops and the PTY event reconciler. Keyed by the
  // incarnation: the run is the newest one linked to `ptyProcessId`, and the
  // state transitions only while its active pointer still names that same
  // incarnation, so a late echo from a superseded process cannot clobber the
  // state a newer launch installed.
  readonly finalizeRunAndStateByPty: (input: {
    readonly worktreeId: number;
    readonly commandName: string;
    readonly ptyProcessId: number;
    readonly runStatus: Exclude<CommandRunStatus, 'running'>;
    readonly stateStatus: CommandStatus;
    readonly diagnosticReason?: CommandRunDiagnosticReason | null | undefined;
    readonly diagnosticDetail?: string | null | undefined;
  }) => Effect.Effect<CommandFinalizeResult, DatabaseError>;
  // Launch-flow convergence. Keyed by the run the caller just created, with the
  // state guarded by `status === 'running'` — the launch-in-progress marker —
  // because the active pointer is still null there and no pointer guard could
  // ever match. The guard is also what leaves a prior entity status (a resume's
  // `suspended`) untouched when the launch never reached its marker.
  readonly finalizeRunAndStateByRun: (input: {
    readonly runId: number;
    readonly worktreeId: number;
    readonly commandName: string;
    readonly runStatus: Exclude<CommandRunStatus, 'running'>;
    readonly stateStatus: CommandStatus;
    readonly diagnosticReason?: CommandRunDiagnosticReason | null | undefined;
    readonly diagnosticDetail?: string | null | undefined;
  }) => Effect.Effect<CommandFinalizeResult, DatabaseError>;
  readonly findLatestRun: (input: {
    readonly worktreeId: number;
    readonly commandName: string;
  }) => Effect.Effect<CommandRunRow | null, DatabaseError>;
  readonly findRunByPtyProcess: (
    ptyProcessId: number,
  ) => Effect.Effect<CommandRunRow | null, DatabaseError>;
  readonly pruneRunHistory: (input: {
    readonly worktreeId: number;
    readonly commandName: string;
    readonly keep: number;
  }) => Effect.Effect<CommandRunRow[], DatabaseError>;
}

export const CommandRepository =
  Context.GenericTag<CommandRepositoryService>('isagi/CommandRepository');

export const CommandRepositoryLive = Layer.effect(
  CommandRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const stateColumns = getTableColumns(worktreeCommandStates);
    const runColumns = getTableColumns(worktreeCommandRuns);

    return {
      listStatesForWorktree: (worktreeId) =>
        database.use('list_worktree_command_states', (db) =>
          db
            .select(stateColumns)
            .from(worktreeCommandStates)
            .where(eq(worktreeCommandStates.worktreeId, worktreeId))
            .all()
            .map(commandStateRow),
        ),
      findState: (input) =>
        database.use('find_worktree_command_state', (db) => {
          const row = db
            .select(stateColumns)
            .from(worktreeCommandStates)
            .where(
              and(
                eq(worktreeCommandStates.worktreeId, input.worktreeId),
                eq(worktreeCommandStates.commandName, input.commandName),
              ),
            )
            .get();
          return row ? commandStateRow(row) : null;
        }),
      listRunningStates: database.use('list_running_worktree_command_states', (db) =>
        db
          .select(stateColumns)
          .from(worktreeCommandStates)
          .where(eq(worktreeCommandStates.status, 'running'))
          .all()
          .map(commandStateRow),
      ),
      listRunningStatesForWorktree: (worktreeId) =>
        database.use('list_running_worktree_command_states_for_worktree', (db) =>
          db
            .select(stateColumns)
            .from(worktreeCommandStates)
            .where(
              and(
                eq(worktreeCommandStates.worktreeId, worktreeId),
                eq(worktreeCommandStates.status, 'running'),
              ),
            )
            .all()
            .map(commandStateRow),
        ),
      ensureState: (input) =>
        database.transaction('ensure_worktree_command_state', (db) => {
          const existing = db
            .select(stateColumns)
            .from(worktreeCommandStates)
            .where(
              and(
                eq(worktreeCommandStates.worktreeId, input.worktreeId),
                eq(worktreeCommandStates.commandName, input.commandName),
              ),
            )
            .get();
          if (existing) return commandStateRow(existing);
          const now = timestamp();
          const inserted = db
            .insert(worktreeCommandStates)
            .values({
              worktreeId: input.worktreeId,
              commandName: input.commandName,
              status: input.status ?? 'idle',
              activePtyProcessId: input.activePtyProcessId ?? null,
              createdAt: now,
              updatedAt: now,
            })
            .returning(stateColumns)
            .get();
          return commandStateRow(inserted);
        }),
      transitionState: (input) =>
        database.transaction('transition_worktree_command_state', (db) => {
          const now = timestamp();
          const existing = db
            .select(stateColumns)
            .from(worktreeCommandStates)
            .where(
              and(
                eq(worktreeCommandStates.worktreeId, input.worktreeId),
                eq(worktreeCommandStates.commandName, input.commandName),
              ),
            )
            .get();
          if (!existing) {
            const inserted = db
              .insert(worktreeCommandStates)
              .values({
                worktreeId: input.worktreeId,
                commandName: input.commandName,
                status: input.status,
                activePtyProcessId: input.activePtyProcessId ?? null,
                createdAt: now,
                updatedAt: now,
              })
              .returning(stateColumns)
              .get();
            return commandStateRow(inserted);
          }
          const updated = db
            .update(worktreeCommandStates)
            .set({
              status: input.status,
              activePtyProcessId:
                input.activePtyProcessId === undefined
                  ? existing.activePtyProcessId
                  : input.activePtyProcessId,
              updatedAt: now,
            })
            .where(eq(worktreeCommandStates.id, existing.id))
            .returning(stateColumns)
            .get();
          return commandStateRow(updated);
        }),
      createRun: (input) =>
        database.use('create_worktree_command_run', (db) => {
          const now = timestamp();
          const completedAt = input.completedAt === undefined ? null : input.completedAt;
          const inserted = db
            .insert(worktreeCommandRuns)
            .values({
              worktreeId: input.worktreeId,
              commandName: input.commandName,
              status: input.status,
              ptyProcessId: input.ptyProcessId ?? null,
              diagnosticReason: input.diagnosticReason ?? null,
              diagnosticDetail: input.diagnosticDetail ?? null,
              startedAt: now,
              completedAt,
              createdAt: now,
              updatedAt: now,
            })
            .returning(runColumns)
            .get();
          return commandRunRow(inserted);
        }),
      updateRunPty: (input) =>
        database.use('update_worktree_command_run_pty', (db) => {
          const row = db
            .update(worktreeCommandRuns)
            .set({
              ptyProcessId: input.ptyProcessId,
              updatedAt: timestamp(),
            })
            .where(eq(worktreeCommandRuns.id, input.runId))
            .returning(runColumns)
            .get();
          return row ? commandRunRow(row) : null;
        }),
      completeRun: (input) =>
        database.use('complete_worktree_command_run', (db) => {
          const now = timestamp();
          const row = db
            .update(worktreeCommandRuns)
            .set({
              status: input.status,
              diagnosticReason: input.diagnosticReason ?? null,
              diagnosticDetail: input.diagnosticDetail ?? null,
              completedAt: now,
              updatedAt: now,
            })
            .where(eq(worktreeCommandRuns.id, input.runId))
            .returning(runColumns)
            .get();
          return row ? commandRunRow(row) : null;
        }),
      finalizeRunAndStateByPty: (input) =>
        database.transaction('finalize_worktree_command_run_and_state_by_pty', (db) =>
          finalizeRunAndState(db, stateColumns, runColumns, input, {
            selectRun: () =>
              db
                .select(runColumns)
                .from(worktreeCommandRuns)
                .where(
                  and(
                    eq(worktreeCommandRuns.worktreeId, input.worktreeId),
                    eq(worktreeCommandRuns.commandName, input.commandName),
                    eq(worktreeCommandRuns.ptyProcessId, input.ptyProcessId),
                  ),
                )
                .orderBy(desc(worktreeCommandRuns.id))
                .get(),
            stateMatches: (state) => state.activePtyProcessId === input.ptyProcessId,
          }),
        ),
      finalizeRunAndStateByRun: (input) =>
        database.transaction('finalize_worktree_command_run_and_state_by_run', (db) =>
          finalizeRunAndState(db, stateColumns, runColumns, input, {
            // Scoped by identity as well as id: a caller that mixes up its
            // inputs must complete nothing rather than complete one command's
            // run while transitioning another command's state.
            selectRun: () =>
              db
                .select(runColumns)
                .from(worktreeCommandRuns)
                .where(
                  and(
                    eq(worktreeCommandRuns.id, input.runId),
                    eq(worktreeCommandRuns.worktreeId, input.worktreeId),
                    eq(worktreeCommandRuns.commandName, input.commandName),
                  ),
                )
                .get(),
            stateMatches: (state) => state.status === 'running',
          }),
        ),
      findLatestRun: (input) =>
        database.use('find_latest_worktree_command_run', (db) => {
          const row = db
            .select(runColumns)
            .from(worktreeCommandRuns)
            .where(
              and(
                eq(worktreeCommandRuns.worktreeId, input.worktreeId),
                eq(worktreeCommandRuns.commandName, input.commandName),
              ),
            )
            .orderBy(desc(worktreeCommandRuns.id))
            .get();
          return row ? commandRunRow(row) : null;
        }),
      findRunByPtyProcess: (ptyProcessId) =>
        database.use('find_worktree_command_run_by_pty', (db) => {
          const row = db
            .select(runColumns)
            .from(worktreeCommandRuns)
            .where(eq(worktreeCommandRuns.ptyProcessId, ptyProcessId))
            .orderBy(desc(worktreeCommandRuns.id))
            .get();
          return row ? commandRunRow(row) : null;
        }),
      // Keep only the newest `keep` runs for a command and delete the rest,
      // returning the deleted rows so the caller can reclaim their command-log
      // files. This is what stops historical runs from pinning PTY rows/logs
      // forever (each retained run is a GC reference); pruned runs let the PTY
      // GC reclaim their now-unreferenced process rows and session logs.
      pruneRunHistory: (input) =>
        database.transaction('prune_worktree_command_runs', (db) => {
          const rows = db
            .select(runColumns)
            .from(worktreeCommandRuns)
            .where(
              and(
                eq(worktreeCommandRuns.worktreeId, input.worktreeId),
                eq(worktreeCommandRuns.commandName, input.commandName),
              ),
            )
            .orderBy(desc(worktreeCommandRuns.id))
            .all();
          const stale = rows.slice(Math.max(input.keep, 0));
          if (stale.length === 0) return [];
          db.delete(worktreeCommandRuns)
            .where(
              inArray(
                worktreeCommandRuns.id,
                stale.map((row) => row.id),
              ),
            )
            .run();
          return stale.map(commandRunRow);
        }),
    } satisfies CommandRepositoryService;
  }),
);

// The shared body of both finalizers, run directly on the caller's transaction
// handle so run completion and state transition commit or roll back together.
// Two guards, both deliberate:
//   - the run is completed only while it is still `running`, so a terminal run's
//     first recorded outcome (and its diagnostics) is never overwritten by a
//     later echo;
//   - the state is transitioned only when the caller's keying guard holds, and
//     its pointer is cleared in the same statement.
// Neither guard implies the other, so a state pointer can be repaired even when
// the run it named has already been pruned or completed.
function finalizeRunAndState(
  db: RuntimeDrizzleDatabase,
  stateColumns: ReturnType<typeof getTableColumns<typeof worktreeCommandStates>>,
  runColumns: ReturnType<typeof getTableColumns<typeof worktreeCommandRuns>>,
  input: {
    readonly worktreeId: number;
    readonly commandName: string;
    readonly runStatus: Exclude<CommandRunStatus, 'running'>;
    readonly stateStatus: CommandStatus;
    readonly diagnosticReason?: CommandRunDiagnosticReason | null | undefined;
    readonly diagnosticDetail?: string | null | undefined;
  },
  keying: {
    readonly selectRun: () => CommandRunRecord | undefined;
    readonly stateMatches: (state: CommandStateRecord) => boolean;
  },
): CommandFinalizeResult {
  const now = timestamp();
  const existingRun = keying.selectRun();
  let run = existingRun ? commandRunRow(existingRun) : null;
  let runCompleted = false;
  if (existingRun && existingRun.status === 'running') {
    const updated = db
      .update(worktreeCommandRuns)
      .set({
        status: input.runStatus,
        diagnosticReason: input.diagnosticReason ?? null,
        diagnosticDetail: input.diagnosticDetail ?? null,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(worktreeCommandRuns.id, existingRun.id))
      .returning(runColumns)
      .get();
    if (updated) {
      run = commandRunRow(updated);
      runCompleted = true;
    }
  }

  const existingState = db
    .select(stateColumns)
    .from(worktreeCommandStates)
    .where(
      and(
        eq(worktreeCommandStates.worktreeId, input.worktreeId),
        eq(worktreeCommandStates.commandName, input.commandName),
      ),
    )
    .get();
  let state = existingState ? commandStateRow(existingState) : null;
  let stateTransitioned = false;
  if (existingState && keying.stateMatches(existingState)) {
    const updated = db
      .update(worktreeCommandStates)
      .set({ status: input.stateStatus, activePtyProcessId: null, updatedAt: now })
      .where(eq(worktreeCommandStates.id, existingState.id))
      .returning(stateColumns)
      .get();
    if (updated) {
      state = commandStateRow(updated);
      stateTransitioned = true;
    }
  }

  return { run, runCompleted, stateTransitioned, state };
}

function commandStateRow(row: CommandStateRecord): CommandStateRow {
  return {
    id: row.id,
    worktreeId: row.worktreeId,
    commandName: row.commandName,
    status: row.status,
    activePtyProcessId: row.activePtyProcessId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function commandRunRow(row: CommandRunRecord): CommandRunRow {
  return {
    id: row.id,
    worktreeId: row.worktreeId,
    commandName: row.commandName,
    ptyProcessId: row.ptyProcessId,
    status: row.status,
    diagnosticReason: row.diagnosticReason,
    diagnosticDetail: row.diagnosticDetail,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function timestamp() {
  return new Date().toISOString();
}
