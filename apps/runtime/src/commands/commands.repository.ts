import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  type InferSelectModel,
} from 'drizzle-orm';
import { Context, Effect, Layer, Schema } from 'effect';

import type { CommandRunDiagnosticReason, CommandRunStatus, CommandStatus } from '@isagi/contracts';

import {
  DatabaseError,
  RuntimeDatabase,
  type RuntimeDrizzleDatabase,
} from '../persistence/index.js';
import { worktreeCommandRuns, worktreeCommandStates } from '../persistence/schema.js';
import { resolvedPortsSnapshotSchema, type ResolvedPortEntry } from './commands.ports.js';

type CommandStateRecord = InferSelectModel<typeof worktreeCommandStates>;
type CommandRunRecord = InferSelectModel<typeof worktreeCommandRuns>;

export interface CommandStateRow {
  readonly id: number;
  readonly worktreeId: number;
  readonly commandName: string;
  readonly status: CommandStatus;
  readonly activePtyProcessId: number | null;
  // The last successfully established resolution, or null when none has been
  // recorded or the stored snapshot did not decode.
  readonly resolvedPorts: readonly ResolvedPortEntry[] | null;
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
    // Omitting this keeps the stored snapshot; an array replaces it. That
    // asymmetry is what makes the supersession rule hold by construction —
    // every transition except the launch marker leaves the memory alone
    // without naming the column at all. No caller writes null.
    readonly resolvedPorts?: readonly ResolvedPortEntry[] | undefined;
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
  // Atomic re-adoption: bind a command to one incarnation it is not currently
  // recorded as owning. In one transaction the state is upserted to `running`
  // with its pointer on the target, the newest run is reopened (or one is
  // inserted when none exists) with its link moved to the same target, and the
  // diagnostic explaining the degraded ownership is written to that run when
  // supplied.
  //
  // The three callers share one semantics: recording a failed stop on a command
  // that is already recorded as owning the incarnation (the rebind is then a
  // no-op and only the diagnostic lands), repairing a pointerless `running`
  // state from its run's own link, and — from Phase 08 — re-adopting an
  // incarnation that survived a cleanup attempt. Reopening a terminal run is
  // sanctioned only because a live process disproves the recorded completion.
  //
  // Callers hold the command lock and must not call this for out-of-model data
  // with more than one nonterminal linked incarnation: the rebind would erase a
  // link to a live process.
  readonly readoptCommandIncarnation: (input: {
    readonly worktreeId: number;
    readonly commandName: string;
    readonly ptyProcessId: number;
    // Omitted, the reopened run keeps whatever diagnostics it already carries —
    // re-adopting ownership is not a reason to destroy an earlier explanation of
    // why this command is in trouble. Provided, both columns move together, so
    // a reason can never end up paired with a stale detail. A defensively
    // inserted run has no history to preserve and starts with nulls.
    readonly diagnostic?:
      | {
          readonly reason: CommandRunDiagnosticReason;
          readonly detail: string | null;
        }
      | undefined;
  }) => Effect.Effect<
    { readonly state: CommandStateRow; readonly run: CommandRunRow },
    DatabaseError
  >;
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
  // Every incarnation a command still durably refers to, from both sources: the
  // state's active pointer and the retained runs' links. Under the single-link
  // invariant the two agree whenever the pointer is set, so this is normally one
  // row per command; the union shape exists so a pointerless state and
  // out-of-model divergence are still enumerated rather than silently dropped.
  //
  // This is the same reference set that pins PTY rows against orphan GC, which
  // is exactly why boot and the deletion audit must drive cleanup from it: an
  // incarnation reachable from here is one nothing else will collect.
  readonly listCommandPtyLinks: Effect.Effect<CommandPtyLink[], DatabaseError>;
  readonly listCommandPtyLinksForWorktree: (
    worktreeId: number,
  ) => Effect.Effect<CommandPtyLink[], DatabaseError>;
  // Boot's run residue: runs still recorded `running` that name no incarnation
  // at all. Linklessness is the structural half of the residue predicate and is
  // stable enough to live in SQL; the caller still re-reads the command state
  // under its lock before completing anything, because that half is racy.
  readonly listLinklessRunningRuns: Effect.Effect<CommandRunRow[], DatabaseError>;
}

// One command's reference to one process incarnation. Deliberately not a row
// type: it is the distinct union of two different columns in two tables, and
// callers only ever need the identity triple to take the command lock and drive
// cleanup.
export interface CommandPtyLink {
  readonly worktreeId: number;
  readonly commandName: string;
  readonly ptyProcessId: number;
}

export const CommandRepository =
  Context.GenericTag<CommandRepositoryService>('isagi/CommandRepository');

export const CommandRepositoryLive = Layer.effect(
  CommandRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const stateColumns = getTableColumns(worktreeCommandStates);
    const runColumns = getTableColumns(worktreeCommandRuns);
    // Link reads project only the identity triple: the union is built in
    // JavaScript from two differently shaped tables, and selecting whole rows
    // would invite a caller to reason about a `CommandPtyLink` as if it were one.
    const stateLinkColumns = {
      worktreeId: worktreeCommandStates.worktreeId,
      commandName: worktreeCommandStates.commandName,
      ptyProcessId: worktreeCommandStates.activePtyProcessId,
    };
    const runLinkColumns = {
      worktreeId: worktreeCommandRuns.worktreeId,
      commandName: worktreeCommandRuns.commandName,
      ptyProcessId: worktreeCommandRuns.ptyProcessId,
    };

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
                resolvedPortsJson:
                  input.resolvedPorts === undefined ? null : JSON.stringify(input.resolvedPorts),
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
              // An empty array is a meaningful replacement — "this incarnation
              // declared no ports" — so the branch is on `undefined`, not on
              // emptiness.
              resolvedPortsJson:
                input.resolvedPorts === undefined
                  ? existing.resolvedPortsJson
                  : JSON.stringify(input.resolvedPorts),
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
      readoptCommandIncarnation: (input) =>
        database.transaction('readopt_worktree_command_incarnation', (db) => {
          const now = timestamp();
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
          const state = existingState
            ? db
                .update(worktreeCommandStates)
                .set({
                  status: 'running',
                  activePtyProcessId: input.ptyProcessId,
                  updatedAt: now,
                })
                .where(eq(worktreeCommandStates.id, existingState.id))
                .returning(stateColumns)
                .get()
            : db
                .insert(worktreeCommandStates)
                .values({
                  worktreeId: input.worktreeId,
                  commandName: input.commandName,
                  status: 'running',
                  activePtyProcessId: input.ptyProcessId,
                  createdAt: now,
                  updatedAt: now,
                })
                .returning(stateColumns)
                .get();

          const existingRun = db
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
          // The diagnostic columns are only named in the update when the caller
          // supplied them, so an omitted diagnostic leaves the persisted values
          // untouched rather than overwriting them with nulls.
          const runDiagnosticColumns = input.diagnostic
            ? {
                diagnosticReason: input.diagnostic.reason,
                diagnosticDetail: input.diagnostic.detail,
              }
            : {};
          const run = existingRun
            ? db
                .update(worktreeCommandRuns)
                .set({
                  status: 'running',
                  ptyProcessId: input.ptyProcessId,
                  ...runDiagnosticColumns,
                  completedAt: null,
                  updatedAt: now,
                })
                .where(eq(worktreeCommandRuns.id, existingRun.id))
                .returning(runColumns)
                .get()
            : db
                .insert(worktreeCommandRuns)
                .values({
                  worktreeId: input.worktreeId,
                  commandName: input.commandName,
                  ptyProcessId: input.ptyProcessId,
                  status: 'running',
                  diagnosticReason: input.diagnostic?.reason ?? null,
                  diagnosticDetail: input.diagnostic?.detail ?? null,
                  startedAt: now,
                  completedAt: null,
                  createdAt: now,
                  updatedAt: now,
                })
                .returning(runColumns)
                .get();

          return { state: commandStateRow(state), run: commandRunRow(run) };
        }),
      listCommandPtyLinks: database.use('list_worktree_command_pty_links', (db) =>
        distinctCommandPtyLinks(
          db.select(stateLinkColumns).from(worktreeCommandStates).all(),
          db.select(runLinkColumns).from(worktreeCommandRuns).all(),
        ),
      ),
      listCommandPtyLinksForWorktree: (worktreeId) =>
        database.use('list_worktree_command_pty_links_for_worktree', (db) =>
          distinctCommandPtyLinks(
            db
              .select(stateLinkColumns)
              .from(worktreeCommandStates)
              .where(eq(worktreeCommandStates.worktreeId, worktreeId))
              .all(),
            db
              .select(runLinkColumns)
              .from(worktreeCommandRuns)
              .where(eq(worktreeCommandRuns.worktreeId, worktreeId))
              .all(),
          ),
        ),
      listLinklessRunningRuns: database.use('list_linkless_running_worktree_command_runs', (db) =>
        db
          .select(runColumns)
          .from(worktreeCommandRuns)
          .where(
            and(
              eq(worktreeCommandRuns.status, 'running'),
              isNull(worktreeCommandRuns.ptyProcessId),
            ),
          )
          .all()
          .map(commandRunRow),
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
    resolvedPorts: decodeResolvedPorts(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Out-of-model stored data degrades to the modeled unknown value instead of
// failing the read: `null` is exactly what the contract already means by
// "unknown for this incarnation". The warning carries identity only — the
// payload is command-derived and adds nothing a support reader needs.
function decodeResolvedPorts(row: CommandStateRecord): readonly ResolvedPortEntry[] | null {
  if (row.resolvedPortsJson === null) {
    return null;
  }
  try {
    return Schema.decodeUnknownSync(resolvedPortsSnapshotSchema)(JSON.parse(row.resolvedPortsJson));
  } catch {
    console.warn(
      `[runtime] Command resolved-port snapshot could not be decoded worktree=${row.worktreeId} command=${row.commandName}`,
    );
    return null;
  }
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

// Distinct by incarnation, not by source. A command whose pointer and retained
// run name the same process — the ordinary case — must be cleaned up once, and
// the callers key their per-command locks off the same triple.
function distinctCommandPtyLinks(
  ...sources: readonly (readonly {
    readonly worktreeId: number;
    readonly commandName: string;
    readonly ptyProcessId: number | null;
  }[])[]
): CommandPtyLink[] {
  const seen = new Map<string, CommandPtyLink>();
  for (const source of sources) {
    for (const row of source) {
      if (row.ptyProcessId === null) continue;
      const link = {
        worktreeId: row.worktreeId,
        commandName: row.commandName,
        ptyProcessId: row.ptyProcessId,
      };
      seen.set(`${link.worktreeId}:${link.commandName}:${link.ptyProcessId}`, link);
    }
  }
  return [...seen.values()];
}
