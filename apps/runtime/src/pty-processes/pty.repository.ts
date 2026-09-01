import { appendFileSync } from 'node:fs';

import { eq, getTableColumns, inArray } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import { DatabaseError, RuntimeDatabase } from '../persistence/index.js';
import {
  agentSessions,
  editorContexts,
  ptyProcesses,
  terminalSessions,
  worktreeCommandRuns,
  worktreeCommandStates,
} from '../persistence/schema.js';
import { ptyProcessRow } from './row-mapper.js';
import { isTerminalPtyProcessStatus } from './types.js';
import type { PtyProcessRow, PtyProcessStatus, PtyProcessStatusReason } from './types.js';

export interface PtyRepositoryService {
  readonly createProcessMetadata: (input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    // Invoked with the generated id as the transaction's final, non-failing
    // operation. It exists so a caller can make an in-memory reservation for
    // the new row co-visible with the row itself: the guarantee is the
    // repository's own write/commit boundary, not any assumption about how the
    // Effect runtime schedules a continuation. The transaction can still fail
    // at commit after the hook ran, so callers must compensate on failure.
    readonly onInserted?: ((ptyProcessId: number) => void) | undefined;
  }) => Effect.Effect<number, DatabaseError>;
  readonly findProcess: (
    ptyProcessId: number,
  ) => Effect.Effect<PtyProcessRow | null, DatabaseError>;
  readonly listProcessLogPaths: Effect.Effect<string[], DatabaseError>;
  readonly listOrphanProcesses: Effect.Effect<PtyProcessRow[], DatabaseError>;
  readonly listProcesses: (input?: {
    readonly statuses?: readonly PtyProcessStatus[];
  }) => Effect.Effect<PtyProcessRow[], DatabaseError>;
  readonly deleteProcess: (ptyProcessId: number) => Effect.Effect<void, DatabaseError>;
  readonly updateBackendRef: (input: {
    readonly ptyProcessId: number;
    readonly backendRefJson: string;
  }) => Effect.Effect<void, DatabaseError>;
  readonly updateBackendMetadata: (input: {
    readonly ptyProcessId: number;
    readonly backend: import('@isagi/contracts').PtyProcessBackend;
    readonly backendRefJson: string;
    readonly logMode: import('@isagi/contracts').PtyProcessLogMode;
    readonly logPath: string | null;
  }) => Effect.Effect<void, DatabaseError>;
  readonly transitionProcess: (input: {
    readonly ptyProcessId: number;
    readonly status: PtyProcessStatus;
    readonly statusReason?: PtyProcessStatusReason | null | undefined;
    readonly exitCode?: number | null | undefined;
    readonly signal?: string | null | undefined;
    readonly lastSeenAt?: string | null | undefined;
  }) => Effect.Effect<PtyProcessTransitionResult, DatabaseError>;
}

// The outcome of a guarded transition. `applied` is the durable authority:
// callers converge on `row` rather than on what they requested, and persistence
// retry loops treat a rejection as resolution instead of retrying forever.
export interface PtyProcessTransitionResult {
  // Post-write row when applied; the persisted row that rejected the write;
  // `null` when the row does not exist.
  readonly applied: boolean;
  readonly row: PtyProcessRow | null;
}

export const PtyRepository = Context.GenericTag<PtyRepositoryService>('isagi/PtyProcessRepository');

export const PtyRepositoryLive = Layer.effect(
  PtyRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const ptyProcessColumns = getTableColumns(ptyProcesses);

    return {
      createProcessMetadata: (input) =>
        // One transaction: the insert and the id-bearing ref update are a
        // single durable fact, and `onInserted` runs inside the same boundary.
        database.transaction('create_pty_process_metadata', (db) => {
          const now = timestamp();
          const placeholderRef = {
            schemaVersion: 1,
            backend: 'node_pty' as const,
            ptyProcessId: 0,
            pid: null,
          };
          const row = db
            .insert(ptyProcesses)
            .values({
              backend: 'node_pty',
              backendRefJson: JSON.stringify(placeholderRef),
              command: input.command,
              argsJson: JSON.stringify([...input.args]),
              cwd: input.cwd,
              status: 'starting',
              statusReason: null,
              exitCode: null,
              signal: null,
              logMode: 'none',
              logPath: null,
              createdAt: now,
              updatedAt: now,
              exitedAt: null,
              lastSeenAt: null,
            })
            .returning({ id: ptyProcesses.id })
            .get();
          db.update(ptyProcesses)
            .set({
              backendRefJson: JSON.stringify({ ...placeholderRef, ptyProcessId: row.id }),
              updatedAt: now,
            })
            .where(eq(ptyProcesses.id, row.id))
            .run();
          // Last, and deliberately not fallible: no expected-failure statement
          // may sit between the hook and the caller's success.
          input.onInserted?.(row.id);
          return row.id;
        }),
      findProcess: (ptyProcessId) => findProcess(database, ptyProcessId, 'find_pty_process'),
      listProcessLogPaths: database.use('list_pty_process_log_paths', (db) =>
        db
          .select({ logPath: ptyProcesses.logPath })
          .from(ptyProcesses)
          .all()
          .flatMap((row) => (row.logPath ? [row.logPath] : [])),
      ),
      listOrphanProcesses: database.use('list_orphan_pty_processes', (db) => {
        const rows = db.select(ptyProcessColumns).from(ptyProcesses).all();
        const referencedIds = new Set(
          [
            ...db
              .select({ activePtyProcessId: agentSessions.activePtyProcessId })
              .from(agentSessions)
              .all(),
            ...db
              .select({ activePtyProcessId: terminalSessions.activePtyProcessId })
              .from(terminalSessions)
              .all(),
            ...db
              .select({ activePtyProcessId: worktreeCommandRuns.ptyProcessId })
              .from(worktreeCommandRuns)
              .all(),
            ...db
              .select({ activePtyProcessId: worktreeCommandStates.activePtyProcessId })
              .from(worktreeCommandStates)
              .all(),
            // Editor incarnations are owned by their durable context, which is
            // not a pane session and therefore appears in none of the tables
            // above. Without this term the GC classifies every live editor
            // process as an orphan and kills it past the retention window —
            // intermittently, and with no diagnostic pointing back here.
            ...db
              .select({ activePtyProcessId: editorContexts.activePtyProcessId })
              .from(editorContexts)
              .all(),
          ].flatMap((row) => (row.activePtyProcessId ? [row.activePtyProcessId] : [])),
        );
        return rows.filter((row) => !referencedIds.has(row.id)).map(ptyProcessRow);
      }),
      listProcesses: (input) =>
        database.use('list_pty_processes', (db) => {
          const rows =
            input?.statuses && input.statuses.length > 0
              ? db
                  .select(ptyProcessColumns)
                  .from(ptyProcesses)
                  .where(inArray(ptyProcesses.status, [...input.statuses]))
                  .all()
              : db.select(ptyProcessColumns).from(ptyProcesses).all();
          return rows.map(ptyProcessRow);
        }),
      deleteProcess: (ptyProcessId) =>
        database.use('delete_pty_process', (db) => {
          db.delete(ptyProcesses).where(eq(ptyProcesses.id, ptyProcessId)).run();
        }),
      updateBackendRef: (input) =>
        database.use('update_pty_process_backend_ref', (db) => {
          db.update(ptyProcesses)
            .set({ backendRefJson: input.backendRefJson, updatedAt: timestamp() })
            .where(eq(ptyProcesses.id, input.ptyProcessId))
            .run();
        }),
      updateBackendMetadata: (input) =>
        database.use('update_pty_process_backend_metadata', (db) => {
          db.update(ptyProcesses)
            .set({
              backend: input.backend,
              backendRefJson: input.backendRefJson,
              logMode: input.logMode,
              logPath: input.logPath,
              updatedAt: timestamp(),
            })
            .where(eq(ptyProcesses.id, input.ptyProcessId))
            .run();
        }),
      // Read, terminal check, and write happen in one transaction so the guard
      // cannot be raced: a row that is already terminal rejects the write and the
      // caller receives the persisted fact rather than the one it asked for.
      transitionProcess: (input) =>
        database.transaction('transition_pty_process', (db) => {
          const existing = db
            .select()
            .from(ptyProcesses)
            .where(eq(ptyProcesses.id, input.ptyProcessId))
            .get();
          if (!existing) return { applied: false, row: null };
          if (isTerminalPtyProcessStatus(existing.status)) {
            return { applied: false, row: ptyProcessRow(existing) };
          }
          const now = timestamp();
          const updated = db
            .update(ptyProcesses)
            .set({
              status: input.status,
              statusReason: input.statusReason ?? null,
              exitCode: input.exitCode ?? null,
              signal: input.signal ?? null,
              updatedAt: now,
              exitedAt: isTerminalPtyProcessStatus(input.status) ? now : null,
              ...(input.lastSeenAt !== undefined ? { lastSeenAt: input.lastSeenAt } : {}),
            })
            .where(eq(ptyProcesses.id, input.ptyProcessId))
            .returning()
            .get();
          return { applied: true, row: ptyProcessRow(updated) };
        }),
    } satisfies PtyRepositoryService;
  }),
);

function findProcess(
  database: import('../persistence/index.js').RuntimeDatabaseService,
  ptyProcessId: number,
  operation: string,
) {
  return database.use(operation, (db) => {
    const row = db.select().from(ptyProcesses).where(eq(ptyProcesses.id, ptyProcessId)).get();
    return row ? ptyProcessRow(row) : null;
  });
}

export class MissingLaunchWorktree extends Error {
  constructor(readonly worktreeId: number) {
    super(`Worktree ${worktreeId} was not found.`);
  }
}

export function appendLog(path: string, data: string) {
  appendFileSync(path, data, 'utf8');
  return Buffer.byteLength(data, 'utf8');
}

function timestamp() {
  return new Date().toISOString();
}
