import { appendFileSync } from 'node:fs';

import { and, eq, getTableColumns, inArray, type InferSelectModel } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type {
  AgentHarness,
  PtySessionPurpose,
  PtySessionStatus,
  PtySessionStatusReason,
} from '@isagi/contracts';

import { DatabaseError, RuntimeDatabase } from '../persistence/index.js';
import { ptySessions, surfacePanes, worktreeSurfaces } from '../persistence/schema.js';
import {
  SurfaceRepository,
  SurfaceRepositoryWorktreeMissing,
  type PtySessionRow,
} from '../surfaces/index.js';
import type { PtySessionLaunchMetadata } from './types.js';

type PtySessionRecord = InferSelectModel<typeof ptySessions>;
type PtySessionRecordWithSurface = PtySessionRecord & { readonly surfaceId: number };

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
  readonly listSessionLogPaths: Effect.Effect<string[], DatabaseError>;
  readonly listSessions: (input?: {
    readonly statuses?: readonly PtySessionStatus[];
  }) => Effect.Effect<PtySessionRow[], DatabaseError>;
  readonly updateBackendRef: (input: {
    readonly ptySessionId: number;
    readonly backendRefJson: string;
  }) => Effect.Effect<void, DatabaseError>;
  readonly updateBackendMetadata: (input: {
    readonly ptySessionId: number;
    readonly backend: import('@isagi/contracts').PtySessionBackend;
    readonly backendRefJson: string;
    readonly logMode: import('@isagi/contracts').PtySessionLogMode;
    readonly logPath: string | null;
  }) => Effect.Effect<void, DatabaseError>;
  readonly transitionSession: (input: {
    readonly ptySessionId: number;
    readonly status: PtySessionStatus;
    readonly statusReason?: PtySessionStatusReason | null | undefined;
    readonly exitCode?: number | null | undefined;
    readonly signal?: string | null | undefined;
    readonly lastSeenAt?: string | null | undefined;
  }) => Effect.Effect<void, DatabaseError>;
}

export const PtyRepository = Context.GenericTag<PtyRepositoryService>('isagi/PtyRepository');

export const PtyRepositoryLive = Layer.effect(
  PtyRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const surfaces = yield* SurfaceRepository;
    const ptySessionColumns = getTableColumns(ptySessions);

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
          const row = db
            .select({ ...ptySessionColumns, surfaceId: surfacePanes.surfaceId })
            .from(ptySessions)
            .innerJoin(surfacePanes, eq(ptySessions.paneId, surfacePanes.id))
            .where(eq(ptySessions.id, ptySessionId))
            .get();
          return row ? ptySessionRow(row) : null;
        }),
      listSessionLogPaths: database.use('list_pty_session_log_paths', (db) =>
        db
          .select({ logPath: ptySessions.logPath })
          .from(ptySessions)
          .all()
          .flatMap((row) => (row.logPath ? [row.logPath] : [])),
      ),
      listSessions: (input) =>
        database.use('list_pty_sessions', (db) => {
          const rows =
            input?.statuses && input.statuses.length > 0
              ? db
                  .select({ ...ptySessionColumns, surfaceId: surfacePanes.surfaceId })
                  .from(ptySessions)
                  .innerJoin(surfacePanes, eq(ptySessions.paneId, surfacePanes.id))
                  .where(inArray(ptySessions.status, [...input.statuses]))
                  .all()
              : db
                  .select({ ...ptySessionColumns, surfaceId: surfacePanes.surfaceId })
                  .from(ptySessions)
                  .innerJoin(surfacePanes, eq(ptySessions.paneId, surfacePanes.id))
                  .all();
          return rows.map(ptySessionRow);
        }),
      updateBackendRef: (input) =>
        database.use('update_pty_backend_ref', (db) => {
          db.update(ptySessions)
            .set({ backendRefJson: input.backendRefJson, updatedAt: timestamp() })
            .where(eq(ptySessions.id, input.ptySessionId))
            .run();
        }),
      updateBackendMetadata: (input) =>
        database.use('update_pty_backend_metadata', (db) => {
          db.update(ptySessions)
            .set({
              backend: input.backend,
              backendRefJson: input.backendRefJson,
              logMode: input.logMode,
              logPath: input.logPath,
              updatedAt: timestamp(),
            })
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

function ptySessionRow(row: PtySessionRecordWithSurface): PtySessionRow {
  return {
    id: row.id,
    paneId: row.paneId,
    surfaceId: row.surfaceId,
    worktreeId: row.worktreeId,
    backend: row.backend,
    backendRefJson: row.backendRefJson,
    purpose: row.purpose,
    harness: row.harness,
    command: row.command,
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

function attentionForStatus(
  status: PtySessionStatus,
  exitCode: number | null,
  signal: string | null,
) {
  if (status === 'running' || status === 'starting') {
    return 'working' as const;
  }
  if (status === 'killed' || (status === 'exited' && exitCode === 0 && signal === null)) {
    return 'idle' as const;
  }
  return 'error' as const;
}

function timestamp() {
  return new Date().toISOString();
}
