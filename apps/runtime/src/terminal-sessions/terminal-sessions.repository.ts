import { and, eq, isNull, lt } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import { DatabaseError, RuntimeDatabase } from '../persistence/index.js';
import { ptyProcesses, surfacePanes, terminalSessions } from '../persistence/schema.js';
import { ptyProcessRow } from '../pty-processes/index.js';
import type { TerminalSessionRow } from '../surfaces/index.js';

export interface TerminalSessionRepositoryService {
  readonly create: (input: {
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
  readonly listOrphans: (input: {
    readonly updatedBefore: string;
  }) => Effect.Effect<TerminalSessionRow[], DatabaseError>;
  readonly delete: (terminalSessionId: number) => Effect.Effect<void, DatabaseError>;
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
            .select({ session: terminalSessions, process: ptyProcesses })
            .from(terminalSessions)
            .leftJoin(ptyProcesses, eq(terminalSessions.activePtyProcessId, ptyProcesses.id))
            .where(eq(terminalSessions.id, terminalSessionId))
            .get();
          return row ? terminalSessionRow(row.session, row.process) : null;
        }),
      findByActivePtyProcessId: (ptyProcessId) =>
        database.use('find_terminal_session_by_active_process', (db) => {
          const row = db
            .select({ session: terminalSessions, process: ptyProcesses })
            .from(terminalSessions)
            .leftJoin(ptyProcesses, eq(terminalSessions.activePtyProcessId, ptyProcesses.id))
            .where(eq(terminalSessions.activePtyProcessId, ptyProcessId))
            .get();
          return row ? terminalSessionRow(row.session, row.process) : null;
        }),
      listOrphans: (input) =>
        database.use('list_orphan_terminal_sessions', (db) =>
          db
            .select({ session: terminalSessions, process: ptyProcesses })
            .from(terminalSessions)
            .leftJoin(
              surfacePanes,
              and(
                eq(surfacePanes.sessionKind, 'terminal_session'),
                eq(surfacePanes.sessionId, terminalSessions.id),
              ),
            )
            .leftJoin(ptyProcesses, eq(terminalSessions.activePtyProcessId, ptyProcesses.id))
            .where(
              and(isNull(surfacePanes.id), lt(terminalSessions.updatedAt, input.updatedBefore)),
            )
            .all()
            .map((row) => terminalSessionRow(row.session, row.process)),
        ),
      delete: (terminalSessionId) =>
        database.use('delete_terminal_session', (db) => {
          db.delete(terminalSessions).where(eq(terminalSessions.id, terminalSessionId)).run();
        }),
    } satisfies TerminalSessionRepositoryService;
  }),
);

function terminalSessionRow(
  row: typeof terminalSessions.$inferSelect,
  process: typeof ptyProcesses.$inferSelect | null,
): TerminalSessionRow {
  return {
    id: row.id,
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
