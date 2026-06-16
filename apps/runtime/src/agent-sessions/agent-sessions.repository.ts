import { and, eq, isNull, lt } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import { DatabaseError, RuntimeDatabase } from '../persistence/index.js';
import { agentSessions, ptyProcesses, surfacePanes } from '../persistence/schema.js';
import type { AgentSessionRow, PtyProcessRow } from '../surfaces/index.js';

export interface AgentSessionRepositoryService {
  readonly create: (input: {
    readonly worktreeId: number;
    readonly harness: AgentHarness;
    readonly cwd: string;
  }) => Effect.Effect<number, DatabaseError>;
  readonly setActivePtyProcess: (input: {
    readonly agentSessionId: number;
    readonly ptyProcessId: number;
  }) => Effect.Effect<void, DatabaseError>;
  readonly find: (agentSessionId: number) => Effect.Effect<AgentSessionRow | null, DatabaseError>;
  readonly findByActivePtyProcessId: (
    ptyProcessId: number,
  ) => Effect.Effect<AgentSessionRow | null, DatabaseError>;
  readonly listOrphans: (input: {
    readonly updatedBefore: string;
  }) => Effect.Effect<AgentSessionRow[], DatabaseError>;
  readonly delete: (agentSessionId: number) => Effect.Effect<void, DatabaseError>;
  readonly recordHarnessSessionObservation: (input: {
    readonly agentSessionId: number;
    readonly harnessSessionId: string;
    readonly harnessSessionRefJson?: string | null | undefined;
  }) => Effect.Effect<void, DatabaseError>;
}

export const AgentSessionRepository = Context.GenericTag<AgentSessionRepositoryService>(
  'isagi/AgentSessionRepository',
);

export const AgentSessionRepositoryLive = Layer.effect(
  AgentSessionRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return {
      create: (input) =>
        database.use('create_agent_session', (db) => {
          const now = new Date().toISOString();
          return db
            .insert(agentSessions)
            .values({
              worktreeId: input.worktreeId,
              harness: input.harness,
              cwd: input.cwd,
              harnessSessionId: null,
              harnessSessionRefJson: null,
              activePtyProcessId: null,
              createdAt: now,
              updatedAt: now,
              lastSeenAt: null,
            })
            .returning({ id: agentSessions.id })
            .get().id;
        }),
      setActivePtyProcess: (input) =>
        database.use('set_agent_session_active_process', (db) => {
          db.update(agentSessions)
            .set({ activePtyProcessId: input.ptyProcessId, updatedAt: new Date().toISOString() })
            .where(eq(agentSessions.id, input.agentSessionId))
            .run();
        }),
      find: (agentSessionId) =>
        database.use('find_agent_session', (db) => {
          const row = db
            .select({ session: agentSessions, process: ptyProcesses })
            .from(agentSessions)
            .leftJoin(ptyProcesses, eq(agentSessions.activePtyProcessId, ptyProcesses.id))
            .where(eq(agentSessions.id, agentSessionId))
            .get();
          return row ? agentSessionRow(row.session, row.process) : null;
        }),
      findByActivePtyProcessId: (ptyProcessId) =>
        database.use('find_agent_session_by_active_process', (db) => {
          const row = db
            .select({ session: agentSessions, process: ptyProcesses })
            .from(agentSessions)
            .leftJoin(ptyProcesses, eq(agentSessions.activePtyProcessId, ptyProcesses.id))
            .where(eq(agentSessions.activePtyProcessId, ptyProcessId))
            .get();
          return row ? agentSessionRow(row.session, row.process) : null;
        }),
      listOrphans: (input) =>
        database.use('list_orphan_agent_sessions', (db) =>
          db
            .select({ session: agentSessions, process: ptyProcesses })
            .from(agentSessions)
            .leftJoin(
              surfacePanes,
              and(
                eq(surfacePanes.sessionKind, 'agent_session'),
                eq(surfacePanes.sessionId, agentSessions.id),
              ),
            )
            .leftJoin(ptyProcesses, eq(agentSessions.activePtyProcessId, ptyProcesses.id))
            .where(and(isNull(surfacePanes.id), lt(agentSessions.updatedAt, input.updatedBefore)))
            .all()
            .map((row) => agentSessionRow(row.session, row.process)),
        ),
      delete: (agentSessionId) =>
        database.use('delete_agent_session', (db) => {
          db.delete(agentSessions).where(eq(agentSessions.id, agentSessionId)).run();
        }),
      recordHarnessSessionObservation: (input) =>
        database.use('record_agent_harness_session_observation', (db) => {
          db.update(agentSessions)
            .set({
              harnessSessionId: input.harnessSessionId,
              harnessSessionRefJson: input.harnessSessionRefJson ?? null,
              lastSeenAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            })
            .where(eq(agentSessions.id, input.agentSessionId))
            .run();
        }),
    } satisfies AgentSessionRepositoryService;
  }),
);

function agentSessionRow(
  row: typeof agentSessions.$inferSelect,
  process: typeof ptyProcesses.$inferSelect | null,
): AgentSessionRow {
  return {
    id: row.id,
    worktreeId: row.worktreeId,
    harness: row.harness,
    cwd: row.cwd,
    harnessSessionId: row.harnessSessionId,
    harnessSessionRefJson: row.harnessSessionRefJson,
    activePtyProcessId: row.activePtyProcessId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastSeenAt: row.lastSeenAt,
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
