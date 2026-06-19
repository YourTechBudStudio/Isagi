import { and, desc, eq, getTableColumns, isNotNull, type InferSelectModel } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type { CommandStatus } from '@isagi/contracts';

import { DatabaseError, RuntimeDatabase } from '../persistence/index.js';
import { worktreeCommandRuns, worktreeCommandStates } from '../persistence/schema.js';

type CommandStateRecord = InferSelectModel<typeof worktreeCommandStates>;
type CommandRunRecord = InferSelectModel<typeof worktreeCommandRuns>;

export type CommandRunTrigger =
  | 'manual_run'
  | 'manual_restart'
  | 'lifecycle_post_create'
  | 'lifecycle_activate';

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
  readonly commandText: string;
  readonly cwd: string;
  readonly status: Exclude<CommandStatus, 'idle'>;
  readonly trigger: CommandRunTrigger;
  readonly logPath: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
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
    readonly commandText: string;
    readonly cwd: string;
    readonly trigger: CommandRunTrigger;
    readonly status: Exclude<CommandStatus, 'idle'>;
    readonly ptyProcessId?: number | null | undefined;
    readonly logPath?: string | null | undefined;
    readonly completedAt?: string | null | undefined;
    readonly exitCode?: number | null | undefined;
    readonly signal?: string | null | undefined;
  }) => Effect.Effect<CommandRunRow, DatabaseError>;
  readonly updateRunPty: (input: {
    readonly runId: number;
    readonly ptyProcessId: number;
    readonly logPath: string | null;
  }) => Effect.Effect<CommandRunRow | null, DatabaseError>;
  readonly updateRunLogPath: (input: {
    readonly runId: number;
    readonly logPath: string;
  }) => Effect.Effect<CommandRunRow | null, DatabaseError>;
  readonly completeRun: (input: {
    readonly runId: number;
    readonly status: Exclude<CommandStatus, 'idle' | 'running'>;
    readonly exitCode?: number | null | undefined;
    readonly signal?: string | null | undefined;
  }) => Effect.Effect<CommandRunRow | null, DatabaseError>;
  readonly completeRunByPtyProcess: (input: {
    readonly ptyProcessId: number;
    readonly status: Exclude<CommandStatus, 'idle' | 'running'>;
    readonly exitCode?: number | null | undefined;
    readonly signal?: string | null | undefined;
  }) => Effect.Effect<CommandRunRow | null, DatabaseError>;
  readonly findLatestRun: (input: {
    readonly worktreeId: number;
    readonly commandName: string;
  }) => Effect.Effect<CommandRunRow | null, DatabaseError>;
  readonly findRunByPtyProcess: (
    ptyProcessId: number,
  ) => Effect.Effect<CommandRunRow | null, DatabaseError>;
  readonly listReferencedPtyProcessIds: Effect.Effect<number[], DatabaseError>;
  readonly listReferencedCommandLogPaths: Effect.Effect<string[], DatabaseError>;
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
              commandText: input.commandText,
              cwd: input.cwd,
              trigger: input.trigger,
              status: input.status,
              ptyProcessId: input.ptyProcessId ?? null,
              logPath: input.logPath ?? null,
              exitCode: input.exitCode ?? null,
              signal: input.signal ?? null,
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
              logPath: input.logPath,
              updatedAt: timestamp(),
            })
            .where(eq(worktreeCommandRuns.id, input.runId))
            .returning(runColumns)
            .get();
          return row ? commandRunRow(row) : null;
        }),
      updateRunLogPath: (input) =>
        database.use('update_worktree_command_run_log_path', (db) => {
          const row = db
            .update(worktreeCommandRuns)
            .set({
              logPath: input.logPath,
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
              exitCode: input.exitCode ?? null,
              signal: input.signal ?? null,
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
              exitCode: input.exitCode ?? null,
              signal: input.signal ?? null,
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
      listReferencedPtyProcessIds: database.use('list_command_run_pty_process_ids', (db) =>
        db
          .select({ ptyProcessId: worktreeCommandRuns.ptyProcessId })
          .from(worktreeCommandRuns)
          .where(isNotNull(worktreeCommandRuns.ptyProcessId))
          .all()
          .flatMap((row) => (row.ptyProcessId ? [row.ptyProcessId] : [])),
      ),
      listReferencedCommandLogPaths: database.use('list_command_run_log_paths', (db) =>
        db
          .select({ logPath: worktreeCommandRuns.logPath })
          .from(worktreeCommandRuns)
          .where(isNotNull(worktreeCommandRuns.logPath))
          .all()
          .flatMap((row) => (row.logPath ? [row.logPath] : [])),
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
    commandText: row.commandText,
    cwd: row.cwd,
    status: row.status,
    trigger: row.trigger,
    logPath: row.logPath,
    exitCode: row.exitCode,
    signal: row.signal,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function timestamp() {
  return new Date().toISOString();
}
