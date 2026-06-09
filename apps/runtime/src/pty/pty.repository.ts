import { appendFileSync } from 'node:fs';

import { and, eq, inArray, type InferSelectModel } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type { AgentHarness, PtySessionPurpose, PtySessionStatus } from '@isagi/contracts';

import { DatabaseError, RuntimeDatabase } from '../persistence/index.js';
import { ptySessions, surfacePanes, worktreeSurfaces } from '../persistence/schema.js';
import {
  SurfaceRepository,
  SurfaceRepositoryWorktreeMissing,
  type PtySessionRow,
} from '../surfaces/index.js';
import type { PtySessionLaunchMetadata } from './types.js';

type PtySessionRecord = InferSelectModel<typeof ptySessions>;

export interface PtyRepositoryService {
  readonly createLaunchMetadata: (input: {
    readonly worktreeId: number;
    readonly kind: 'agent' | 'terminal';
    readonly titleBase: string;
    readonly purpose: PtySessionPurpose;
    readonly harness: AgentHarness | null;
    readonly command: string;
  }) => Effect.Effect<PtySessionLaunchMetadata, DatabaseError>;
  readonly findSession: (
    ptySessionId: number,
  ) => Effect.Effect<PtySessionRow | null, DatabaseError>;
  readonly listLivePersistedSessions: Effect.Effect<PtySessionRow[], DatabaseError>;
  readonly appendLogBytes: (input: {
    readonly ptySessionId: number;
    readonly bytes: number;
  }) => Effect.Effect<void, DatabaseError>;
  readonly setLogBytes: (input: {
    readonly ptySessionId: number;
    readonly bytes: number;
  }) => Effect.Effect<void, DatabaseError>;
  readonly transitionSession: (input: {
    readonly ptySessionId: number;
    readonly status: PtySessionStatus;
    readonly exitCode?: number | null | undefined;
    readonly signal?: string | null | undefined;
  }) => Effect.Effect<void, DatabaseError>;
}

export const PtyRepository = Context.GenericTag<PtyRepositoryService>('isagi/PtyRepository');

export const PtyRepositoryLive = Layer.effect(
  PtyRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const surfaces = yield* SurfaceRepository;

    return {
      createLaunchMetadata: (input) =>
        surfaces
          .createSinglePanePtySessionSurface({
            worktreeId: input.worktreeId,
            kind: input.kind,
            titleBase: input.titleBase,
            purpose: input.purpose,
            harness: input.harness,
            command: input.command,
          })
          .pipe(
            Effect.catchTag('DatabaseError', (error) => {
              if (isMissingWorktreeCause(error.cause, input.worktreeId)) {
                return Effect.fail(
                  new DatabaseError({
                    operation: error.operation,
                    cause: new MissingLaunchWorktree(input.worktreeId),
                  }),
                );
              }
              return Effect.fail(error);
            }),
          ),
      findSession: (ptySessionId) =>
        database.use('find_pty_session', (db) => {
          const row = db.select().from(ptySessions).where(eq(ptySessions.id, ptySessionId)).get();
          return row ? ptySessionRow(row) : null;
        }),
      listLivePersistedSessions: database.use('list_live_persisted_pty_sessions', (db) =>
        db
          .select()
          .from(ptySessions)
          .where(inArray(ptySessions.status, ['starting', 'running']))
          .all()
          .map(ptySessionRow),
      ),
      appendLogBytes: (input) =>
        database.use('append_pty_log_bytes', (db) => {
          const row = db
            .select({ logBytes: ptySessions.logBytes })
            .from(ptySessions)
            .where(eq(ptySessions.id, input.ptySessionId))
            .get();
          if (!row) {
            return;
          }
          db.update(ptySessions)
            .set({ logBytes: row.logBytes + input.bytes, updatedAt: timestamp() })
            .where(eq(ptySessions.id, input.ptySessionId))
            .run();
        }),
      setLogBytes: (input) =>
        database.use('set_pty_log_bytes', (db) => {
          db.update(ptySessions)
            .set({ logBytes: input.bytes, updatedAt: timestamp() })
            .where(eq(ptySessions.id, input.ptySessionId))
            .run();
        }),
      transitionSession: (input) =>
        database.use('transition_pty_session', (db) => {
          const now = timestamp();
          const attention = attentionForStatus(
            input.status,
            input.exitCode ?? null,
            input.signal ?? null,
          );
          const session = db
            .select({ paneId: ptySessions.paneId })
            .from(ptySessions)
            .where(eq(ptySessions.id, input.ptySessionId))
            .get();
          if (!session) {
            return;
          }
          const pane = db
            .select({ surfaceId: surfacePanes.surfaceId })
            .from(surfacePanes)
            .where(eq(surfacePanes.id, session.paneId))
            .get();

          db.update(ptySessions)
            .set({
              status: input.status,
              exitCode: input.exitCode ?? null,
              signal: input.signal ?? null,
              updatedAt: now,
              exitedAt: input.status === 'exited' || input.status === 'failed' ? now : null,
            })
            .where(eq(ptySessions.id, input.ptySessionId))
            .run();
          db.update(surfacePanes)
            .set({ attention, updatedAt: now })
            .where(eq(surfacePanes.id, session.paneId))
            .run();
          if (pane) {
            db.update(worktreeSurfaces)
              .set({ attention, updatedAt: now })
              .where(and(eq(worktreeSurfaces.id, pane.surfaceId)))
              .run();
          }
        }),
    } satisfies PtyRepositoryService;
  }),
);

export class MissingLaunchWorktree extends Error {
  constructor(readonly worktreeId: number) {
    super(`Worktree ${worktreeId} was not found.`);
  }
}

export function appendLog(path: string, data: string) {
  appendFileSync(path, data, 'utf8');
  return Buffer.byteLength(data, 'utf8');
}

function isMissingWorktreeCause(cause: unknown, worktreeId: number) {
  return cause instanceof SurfaceRepositoryWorktreeMissing && cause.worktreeId === worktreeId;
}

function ptySessionRow(row: PtySessionRecord): PtySessionRow {
  return {
    id: row.id,
    paneId: row.paneId,
    worktreeId: row.worktreeId,
    adapter: row.adapter,
    purpose: row.purpose,
    harness: row.harness,
    command: row.command,
    cwd: row.cwd,
    status: row.status,
    exitCode: row.exitCode,
    signal: row.signal,
    logPath: row.logPath,
    logBytes: row.logBytes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    exitedAt: row.exitedAt,
  };
}

function attentionForStatus(
  status: PtySessionStatus,
  exitCode: number | null,
  signal: string | null,
) {
  if (status === 'running' || status === 'starting') {
    return 'working' as const;
  }
  if (status === 'exited' && exitCode === 0 && signal === null) {
    return 'idle' as const;
  }
  return 'error' as const;
}

function timestamp() {
  return new Date().toISOString();
}
