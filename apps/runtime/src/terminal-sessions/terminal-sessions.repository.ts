import { eq } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import { DatabaseError, RuntimeDatabase } from '../persistence/index.js';
import { ptyProcesses, surfacePanes, terminalSessions } from '../persistence/schema.js';
import type { PtyProcessRow, TerminalSessionRow } from '../surfaces/index.js';

export interface TerminalSessionRepositoryService {
  readonly create: (input: {
    readonly paneId: number;
    readonly worktreeId: number;
    readonly cwd: string;
    readonly shellCommand: string;
    readonly shellArgs: readonly string[];
  }) => Effect.Effect<number, DatabaseError>;
  readonly setActivePtyProcess: (input: {
    readonly terminalSessionId: number;
    readonly ptyProcessId: number;
  }) => Effect.Effect<void, DatabaseError>;
  readonly find: (
    terminalSessionId: number,
  ) => Effect.Effect<TerminalSessionRow | null, DatabaseError>;
  readonly findByActivePtyProcessId: (
    ptyProcessId: number,
  ) => Effect.Effect<TerminalSessionRow | null, DatabaseError>;
}

export const TerminalSessionRepository = Context.GenericTag<TerminalSessionRepositoryService>(
  'isagi/TerminalSessionRepository',
);

export const TerminalSessionRepositoryLive = Layer.effect(
  TerminalSessionRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return {
      create: (input) =>
        database.use('create_terminal_session', (db) => {
          const now = new Date().toISOString();
          return db
            .insert(terminalSessions)
            .values({
              paneId: input.paneId,
              worktreeId: input.worktreeId,
              cwd: input.cwd,
              shellCommand: input.shellCommand,
              shellArgsJson: JSON.stringify([...input.shellArgs]),
              activePtyProcessId: null,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: terminalSessions.id })
            .get().id;
        }),
      setActivePtyProcess: (input) =>
        database.use('set_terminal_session_active_process', (db) => {
          db.update(terminalSessions)
            .set({ activePtyProcessId: input.ptyProcessId, updatedAt: new Date().toISOString() })
            .where(eq(terminalSessions.id, input.terminalSessionId))
            .run();
        }),
      find: (terminalSessionId) =>
        database.use('find_terminal_session', (db) => {
          const row = db
            .select({
              session: terminalSessions,
              surfaceId: surfacePanes.surfaceId,
              process: ptyProcesses,
            })
            .from(terminalSessions)
            .innerJoin(surfacePanes, eq(terminalSessions.paneId, surfacePanes.id))
            .leftJoin(ptyProcesses, eq(terminalSessions.activePtyProcessId, ptyProcesses.id))
            .where(eq(terminalSessions.id, terminalSessionId))
            .get();
          return row ? terminalSessionRow(row.session, row.surfaceId, row.process) : null;
        }),
      findByActivePtyProcessId: (ptyProcessId) =>
        database.use('find_terminal_session_by_active_process', (db) => {
          const row = db
            .select({
              session: terminalSessions,
              surfaceId: surfacePanes.surfaceId,
              process: ptyProcesses,
            })
            .from(terminalSessions)
            .innerJoin(surfacePanes, eq(terminalSessions.paneId, surfacePanes.id))
            .leftJoin(ptyProcesses, eq(terminalSessions.activePtyProcessId, ptyProcesses.id))
            .where(eq(terminalSessions.activePtyProcessId, ptyProcessId))
            .get();
          return row ? terminalSessionRow(row.session, row.surfaceId, row.process) : null;
        }),
    } satisfies TerminalSessionRepositoryService;
  }),
);

function terminalSessionRow(
  row: typeof terminalSessions.$inferSelect,
  surfaceId: number,
  process: typeof ptyProcesses.$inferSelect | null,
): TerminalSessionRow {
  return {
    id: row.id,
    paneId: row.paneId,
    surfaceId,
    worktreeId: row.worktreeId,
    cwd: row.cwd,
    shellCommand: row.shellCommand,
    shellArgs: decodeArgs(row.shellArgsJson),
    shellArgsJson: row.shellArgsJson,
    activePtyProcessId: row.activePtyProcessId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    activePtyProcess: process ? ptyProcessRow(process) : null,
  };
}

function ptyProcessRow(row: typeof ptyProcesses.$inferSelect): PtyProcessRow {
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
