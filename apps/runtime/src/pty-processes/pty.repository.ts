import { appendFileSync } from 'node:fs';

import { eq, getTableColumns, inArray, type InferSelectModel } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import { DatabaseError, RuntimeDatabase } from '../persistence/index.js';
import { agentSessions, ptyProcesses, terminalSessions } from '../persistence/schema.js';
import type { PtyProcessRow } from '../surfaces/index.js';
import type { PtyProcessStatus, PtyProcessStatusReason } from './types.js';

type PtyProcessTableRow = InferSelectModel<typeof ptyProcesses>;

export interface PtyRepositoryService {
  readonly createProcessMetadata: (input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
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
  }) => Effect.Effect<void, DatabaseError>;
}

export const PtyRepository = Context.GenericTag<PtyRepositoryService>('isagi/PtyProcessRepository');

export const PtyRepositoryLive = Layer.effect(
  PtyRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const ptyProcessColumns = getTableColumns(ptyProcesses);

    return {
      createProcessMetadata: (input) =>
        database.use('create_pty_process_metadata', (db) => {
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
      transitionProcess: (input) =>
        database.use('transition_pty_process', (db) => {
          const now = timestamp();
          db.update(ptyProcesses)
            .set({
              status: input.status,
              statusReason: input.statusReason ?? null,
              exitCode: input.exitCode ?? null,
              signal: input.signal ?? null,
              updatedAt: now,
              exitedAt:
                input.status === 'exited' || input.status === 'failed' || input.status === 'killed'
                  ? now
                  : null,
              ...(input.lastSeenAt !== undefined ? { lastSeenAt: input.lastSeenAt } : {}),
            })
            .where(eq(ptyProcesses.id, input.ptyProcessId))
            .run();
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

function ptyProcessRow(row: PtyProcessTableRow): PtyProcessRow {
  return {
    id: row.id,
    backend: row.backend,
    backendRefJson: row.backendRefJson,
    command: row.command,
    args: decodeArgs(row.argsJson),
    argsJson: row.argsJson,
    cwd: row.cwd,
    status: row.status,
    statusReason: row.statusReason,
    exitCode: row.exitCode,
    signal: row.signal,
    logMode: row.logMode,
    logPath: row.logPath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    exitedAt: row.exitedAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function decodeArgs(json: string) {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function timestamp() {
  return new Date().toISOString();
}
