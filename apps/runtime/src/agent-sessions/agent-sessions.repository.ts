import { and, eq, isNull, lt } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import { DatabaseError, RuntimeDatabase } from '../persistence/index.js';
import { agentSessions, ptyProcesses, surfacePanes } from '../persistence/schema.js';
import type { AgentSessionRow } from '../surfaces/index.js';
import { agentSessionRow } from '../surfaces/row-mappers.js';
import { AgentSessionArtifacts } from './harness/ledger.js';

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
}

export const AgentSessionRepository = Context.GenericTag<AgentSessionRepositoryService>(
  'isagi/AgentSessionRepository',
);

export const AgentSessionRepositoryLive = Layer.effect(
  AgentSessionRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const artifacts = yield* AgentSessionArtifacts;
    return {
      create: (input) =>
        Effect.gen(function* () {
          const agentSessionId = yield* database.use('create_agent_session', (db) => {
            const now = new Date().toISOString();
            return db
              .insert(agentSessions)
              .values({
                worktreeId: input.worktreeId,
                harness: input.harness,
                cwd: input.cwd,
                activePtyProcessId: null,
                createdAt: now,
                updatedAt: now,
                lastSeenAt: null,
              })
              .returning({ id: agentSessions.id })
              .get().id;
          });
          yield* artifacts.initializeMetadata(agentSessionId).pipe(
            Effect.catchAll((error) =>
              Effect.sync(() => {
                console.warn('[runtime] Agent session metadata initialization failed', {
                  agentSessionId,
                  path: error.path,
                  code: error.code,
                  cause: error.cause,
                });
              }),
            ),
          );
          return agentSessionId;
        }),
      setActivePtyProcess: (input) =>
        database.use('set_agent_session_active_process', (db) => {
          db.update(agentSessions)
            .set({ activePtyProcessId: input.ptyProcessId, updatedAt: new Date().toISOString() })
            .where(eq(agentSessions.id, input.agentSessionId))
            .run();
        }),
      find: (agentSessionId) =>
        Effect.gen(function* () {
          const row = yield* database.use('find_agent_session', (db) =>
            db
              .select({ session: agentSessions, process: ptyProcesses })
              .from(agentSessions)
              .leftJoin(ptyProcesses, eq(agentSessions.activePtyProcessId, ptyProcesses.id))
              .where(eq(agentSessions.id, agentSessionId))
              .get(),
          );
          return row ? yield* agentSessionRow(artifacts, row.session, row.process) : null;
        }),
      findByActivePtyProcessId: (ptyProcessId) =>
        Effect.gen(function* () {
          const row = yield* database.use('find_agent_session_by_active_process', (db) =>
            db
              .select({ session: agentSessions, process: ptyProcesses })
              .from(agentSessions)
              .leftJoin(ptyProcesses, eq(agentSessions.activePtyProcessId, ptyProcesses.id))
              .where(eq(agentSessions.activePtyProcessId, ptyProcessId))
              .get(),
          );
          return row ? yield* agentSessionRow(artifacts, row.session, row.process) : null;
        }),
      listOrphans: (input) =>
        Effect.gen(function* () {
          const rows = yield* database.use('list_orphan_agent_sessions', (db) =>
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
              .all(),
          );
          return yield* Effect.all(
            rows.map((row) => agentSessionRow(artifacts, row.session, row.process)),
          );
        }),
      delete: (agentSessionId) =>
        Effect.gen(function* () {
          yield* database.use('delete_agent_session', (db) => {
            db.delete(agentSessions).where(eq(agentSessions.id, agentSessionId)).run();
          });
          yield* artifacts.removeDirectory(agentSessionId).pipe(
            Effect.catchAll((error) =>
              Effect.sync(() => {
                console.warn('[runtime] Agent session artifact cleanup failed', {
                  agentSessionId,
                  path: error.path,
                  code: error.code,
                  cause: error.cause,
                });
              }),
            ),
          );
        }),
    } satisfies AgentSessionRepositoryService;
  }),
);
