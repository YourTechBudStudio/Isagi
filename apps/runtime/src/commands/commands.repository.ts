import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  type InferSelectModel,
} from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type { CommandRunDiagnosticReason, CommandRunStatus, CommandStatus } from '@isagi/contracts';

import { DatabaseError, RuntimeDatabase } from '../persistence/index.js';
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
  readonly completeRunByPtyProcess: (input: {
    readonly ptyProcessId: number;
    readonly status: Exclude<CommandRunStatus, 'running'>;
    readonly diagnosticReason?: CommandRunDiagnosticReason | null | undefined;
    readonly diagnosticDetail?: string | null | undefined;
  }) => Effect.Effect<CommandRunRow | null, DatabaseError>;
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
  readonly listReferencedPtyProcessIds: Effect.Effect<number[], DatabaseError>;
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
      completeRunByPtyProcess: (input) =>
        database.use('complete_worktree_command_run_by_pty', (db) => {
          const now = timestamp();
          const existing = db
            .select(runColumns)
            .from(worktreeCommandRuns)
            .where(eq(worktreeCommandRuns.ptyProcessId, input.ptyProcessId))
            .orderBy(desc(worktreeCommandRuns.id))
            .get();
          if (!existing) return null;
          const row = db
            .update(worktreeCommandRuns)
            .set({
              status: input.status,
              diagnosticReason: input.diagnosticReason ?? null,
              diagnosticDetail: input.diagnosticDetail ?? null,
              completedAt: now,
              updatedAt: now,
            })
            .where(eq(worktreeCommandRuns.id, existing.id))
            .returning(runColumns)
            .get();
          return row ? commandRunRow(row) : null;
        }),
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
      listReferencedPtyProcessIds: database.use('list_command_run_pty_process_ids', (db) =>
        db
          .select({ ptyProcessId: worktreeCommandRuns.ptyProcessId })
          .from(worktreeCommandRuns)
          .where(isNotNull(worktreeCommandRuns.ptyProcessId))
          .all()
          .flatMap((row) => (row.ptyProcessId ? [row.ptyProcessId] : [])),
      ),
    } satisfies CommandRepositoryService;
  }),
);

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
