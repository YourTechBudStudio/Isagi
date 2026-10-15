import { and, eq, isNull, lt } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import { AgentSessionArtifacts } from '../../harnesses/index.js';
import { describeOperationalCause } from '../../platform/diagnostics/index.js';
import { DatabaseError, RuntimeDatabase } from '../../platform/persistence/index.js';
import { worktrees } from '../../projects/tables.js';
import { ptyProcesses } from '../../pty-processes/tables.js';
import { agentSessionRow } from '../sessions/row-mappers.js';
import type { AgentSessionRow } from '../sessions/types.js';
import { agentSessions, surfacePanes } from '../tables.js';

const make = Effect.gen(function* () {
  const database = yield* RuntimeDatabase;
  const artifacts = yield* AgentSessionArtifacts;
  return AgentSessionRepository.of({
    create: Effect.fn('AgentSessionRepository.create')(function* (input) {
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
      // A session without its metadata file still exists: restoring it later reports the missing metadata.
      yield* artifacts.initializeMetadata(agentSessionId).pipe(
        Effect.catch((error) =>
          Effect.logWarning('Agent session metadata initialization failed').pipe(
            Effect.annotateLogs({
              agentSessionId,
              path: error.path,
              code: error.code,
              cause: describeOperationalCause(error.cause),
            }),
          ),
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
    find: Effect.fn('AgentSessionRepository.find')(function* (agentSessionId) {
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
    findByActivePtyProcessId: Effect.fn('AgentSessionRepository.findByActivePtyProcessId')(
      function* (ptyProcessId) {
        const row = yield* database.use('find_agent_session_by_active_process', (db) =>
          db
            .select({ session: agentSessions, process: ptyProcesses })
            .from(agentSessions)
            .leftJoin(ptyProcesses, eq(agentSessions.activePtyProcessId, ptyProcesses.id))
            .where(eq(agentSessions.activePtyProcessId, ptyProcessId))
            .get(),
        );
        return row ? yield* agentSessionRow(artifacts, row.session, row.process) : null;
      },
    ),
    listOrphans: Effect.fn('AgentSessionRepository.listOrphans')(function* (input) {
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
    listIds: database.use(
      'list_agent_session_ids',
      (db) =>
        new Set(
          db
            .select({ id: agentSessions.id })
            .from(agentSessions)
            .all()
            .map((row) => row.id),
        ),
    ),
    // Row only: the session folder is reclaimed later by the orphan-folder collector on the
    // SessionGc tick, which also covers rows removed by worktree and project cascades.
    delete: (agentSessionId) =>
      database.use('delete_agent_session', (db) => {
        db.delete(agentSessions).where(eq(agentSessions.id, agentSessionId)).run();
      }),
    findPlacement: (agentSessionId) =>
      database.use('find_agent_session_placement', (db) => {
        const pane = db
          .select({ surfaceId: surfacePanes.surfaceId, paneId: surfacePanes.id })
          .from(surfacePanes)
          .where(
            and(
              eq(surfacePanes.sessionKind, 'agent_session'),
              eq(surfacePanes.sessionId, agentSessionId),
            ),
          )
          .get();
        return pane ?? null;
      }),
    findProjectId: (worktreeId) =>
      database.use('find_agent_session_project', (db) => {
        const row = db
          .select({ projectId: worktrees.projectId })
          .from(worktrees)
          .where(eq(worktrees.id, worktreeId))
          .get();
        return row?.projectId ?? null;
      }),
  });
});

export class AgentSessionRepository extends Context.Service<
  AgentSessionRepository,
  {
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
    readonly listIds: Effect.Effect<ReadonlySet<number>, DatabaseError>;
    readonly delete: (agentSessionId: number) => Effect.Effect<void, DatabaseError>;
    /** The pane holding the session, or null. Read the way `listOrphans` reads it. */
    readonly findPlacement: (
      agentSessionId: number,
    ) => Effect.Effect<
      { readonly surfaceId: number; readonly paneId: number } | null,
      DatabaseError
    >;
    /** The project owning a worktree (a read-only join, ADR 0008), or null once it is gone. */
    readonly findProjectId: (worktreeId: number) => Effect.Effect<number | null, DatabaseError>;
  }
>()('isagi/runtime/environment/AgentSessionRepository') {
  static readonly layerNoDeps = Layer.effect(AgentSessionRepository, make);
  static readonly layer = AgentSessionRepository.layerNoDeps.pipe(
    Layer.provide(AgentSessionArtifacts.layer),
  );
}
