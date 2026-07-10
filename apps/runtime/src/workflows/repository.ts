import { and, asc, eq, getTableColumns, sql, type InferSelectModel } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import {
  DatabaseError,
  RuntimeDatabase,
  type RuntimeDatabaseService,
} from '../persistence/index.js';
import { workflowRunEvents, workflowRuns } from '../persistence/schema.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import type {
  WorkflowWaitCondition,
  WorkflowHeadlessResult,
  WorkflowRunRow,
  WorkflowStatus,
  WorkflowWaitKind,
} from './types.js';

type WorkflowRunRecord = InferSelectModel<typeof workflowRuns>;

export interface WorkflowRepositoryService {
  readonly createRun: (input: {
    readonly workflowKey: string;
    readonly workflowTitle: string;
    readonly workflowArtifactHash: string;
    readonly state: unknown;
    readonly stateVersion: number;
    readonly worktreeId?: number | null | undefined;
    readonly surfaceId?: number | null | undefined;
    readonly parentRunId?: number | null | undefined;
    readonly rootRunId?: number | null | undefined;
  }) => Effect.Effect<WorkflowRunRow, DatabaseError>;
  readonly listReadyRuns: Effect.Effect<WorkflowRunRow[], DatabaseError>;
  readonly findRun: (runId: number) => Effect.Effect<WorkflowRunRow | null, DatabaseError>;
  readonly findLatestRootRunForSurface: (
    surfaceId: number,
  ) => Effect.Effect<WorkflowRunRow | null, DatabaseError>;
  readonly listRuns: (filters: {
    readonly surfaceId?: number | undefined;
    readonly worktreeId?: number | undefined;
    readonly status?: WorkflowStatus | undefined;
    readonly rootOnly?: boolean | undefined;
  }) => Effect.Effect<WorkflowRunRow[], DatabaseError>;
  readonly listSurfaceDeletedRootRuns: Effect.Effect<WorkflowRunRow[], DatabaseError>;
  readonly listRunTree: (rootRunId: number) => Effect.Effect<WorkflowRunRow[], DatabaseError>;
  readonly pauseNonTerminalRuns: Effect.Effect<number, DatabaseError>;
  readonly setPausedForRunTree: (input: {
    readonly rootRunId: number;
    readonly paused: boolean;
  }) => Effect.Effect<WorkflowRunRow[], DatabaseError>;
  readonly requestCancelForRunTree: (
    rootRunId: number,
  ) => Effect.Effect<WorkflowRunRow[], DatabaseError>;
  readonly deleteRunTree: (input: {
    readonly rootRunId: number;
    readonly surfaceId: number | null;
  }) => Effect.Effect<number, DatabaseError>;
  readonly retryFailedRun: (runId: number) => Effect.Effect<WorkflowRunRow | null, DatabaseError>;
  readonly claimReadyRun: (input: {
    readonly runId: number;
    readonly owner: string;
  }) => Effect.Effect<WorkflowRunRow | null, DatabaseError>;
  readonly findWaitingAgentTurnRuns: (
    agentSessionId: number,
  ) => Effect.Effect<WorkflowRunRow[], DatabaseError>;
  readonly findWaitingWorkflowRuns: (
    childRunId: number,
  ) => Effect.Effect<WorkflowRunRow[], DatabaseError>;
  readonly resolveWorkflowJoin: (
    condition: Extract<WorkflowWaitCondition, { readonly kind: 'workflow' }>,
  ) => Effect.Effect<WorkflowJoinResolution, DatabaseError>;
  readonly wakeWaitingRun: (input: {
    readonly runId: number;
    readonly resumePayload: WorkflowResumePayload;
  }) => Effect.Effect<boolean, DatabaseError>;
  readonly readyPausedRun: (input: {
    readonly runId: number;
    readonly resumePayload?: WorkflowResumePayload | undefined;
  }) => Effect.Effect<boolean, DatabaseError>;
  readonly rearmPausedRun: (runId: number) => Effect.Effect<boolean, DatabaseError>;
  readonly completeCont: (input: {
    readonly runId: number;
    readonly state: unknown;
  }) => Effect.Effect<void, DatabaseError>;
  readonly completeSuspend: (input: {
    readonly runId: number;
    readonly state: unknown;
    readonly waitKind: WorkflowWaitKind;
    readonly waitCondition: unknown;
  }) => Effect.Effect<void, DatabaseError>;
  readonly completeDone: (input: {
    readonly runId: number;
    readonly state: unknown;
    readonly value?: unknown | undefined;
  }) => Effect.Effect<void, DatabaseError>;
  readonly failRun: (input: {
    readonly runId: number;
    readonly error: WorkflowRunErrorPayload;
    readonly stateSnapshot: WorkflowStateSnapshotInput;
    readonly thrown: boolean;
  }) => Effect.Effect<void, DatabaseError>;
  readonly failNonTerminalRun: (input: {
    readonly runId: number;
    readonly error: WorkflowRunErrorPayload;
    readonly stateSnapshot: WorkflowStateSnapshotInput;
    readonly thrown: boolean;
  }) => Effect.Effect<void, DatabaseError>;
}

export interface WorkflowRunErrorPayload {
  readonly message: string;
  readonly stack?: string | undefined;
  readonly context?: Record<string, unknown> | undefined;
}

export type WorkflowStateSnapshotInput =
  | { readonly state: unknown }
  | { readonly stateJson: string };

type WorkflowRunEventTrigger =
  | { readonly kind: 'initial' }
  | { readonly kind: 'cont' }
  | { readonly kind: 'suspend'; readonly waitKind: WorkflowWaitKind }
  | { readonly kind: 'done'; readonly hasValue: boolean }
  | { readonly kind: 'fail'; readonly thrown: boolean };

export type WorkflowResumePayload =
  | { readonly outcome: 'ended'; readonly recordedAt: string }
  | { readonly outcome: 'failed'; readonly recordedAt: string; readonly reason: string }
  | { readonly kind: 'user_continue' }
  | {
      readonly kind: 'user_input';
      readonly answers: Record<string, string | string[] | boolean>;
    }
  | { readonly kind: 'headless_agent'; readonly results: readonly WorkflowHeadlessResult[] }
  | { readonly kind: 'workflow'; readonly results: readonly WorkflowJoinResult[] };

export interface WorkflowJoinResult {
  readonly runId: number;
  readonly status: 'done' | 'failed';
  readonly result?: unknown | undefined;
  readonly error?: WorkflowRunErrorPayload | undefined;
}

export type WorkflowJoinResolution =
  | { readonly status: 'pending' }
  | { readonly status: 'missing'; readonly runId: number }
  | { readonly status: 'complete'; readonly results: readonly WorkflowJoinResult[] };

export const WorkflowRepository = Context.GenericTag<WorkflowRepositoryService>(
  'isagi/WorkflowRepository',
);

export const WorkflowRepositoryLive = Layer.effect(
  WorkflowRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const eventBus = yield* InternalRuntimeEventBus;
    const runColumns = getTableColumns(workflowRuns);

    return {
      createRun: (input) =>
        database
          .transaction('create_workflow_run', (db) => {
            const now = timestamp();
            const inserted = db
              .insert(workflowRuns)
              .values({
                workflowKey: input.workflowKey,
                workflowTitle: input.workflowTitle,
                workflowArtifactHash: input.workflowArtifactHash,
                worktreeId: input.worktreeId ?? null,
                surfaceId: input.surfaceId ?? null,
                parentRunId: input.parentRunId ?? null,
                rootRunId: input.rootRunId ?? null,
                status: 'ready',
                waitKind: null,
                waitCondition: null,
                resumePayload: null,
                stateJson: json(input.state),
                stateVersion: input.stateVersion,
                owner: null,
                error: null,
                resultJson: null,
                createdAt: now,
                updatedAt: now,
              })
              .returning(runColumns)
              .get();
            const row =
              inserted.rootRunId === null && inserted.parentRunId === null
                ? db
                    .update(workflowRuns)
                    .set({ rootRunId: inserted.id })
                    .where(eq(workflowRuns.id, inserted.id))
                    .returning(runColumns)
                    .get()
                : inserted;
            insertRunEvent(db, {
              workflowRunId: row.id,
              recordedAt: now,
              stateJson: json(input.state),
              trigger: { kind: 'initial' },
            });
            return workflowRunRow(row);
          })
          .pipe(Effect.tap((run) => publishWorkflowRunTouched(eventBus, run))),
      listReadyRuns: database.use('list_ready_workflow_runs', (db) =>
        db
          .select(runColumns)
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.status, 'ready'),
              sql`(${workflowRuns.paused} = 0 OR ${workflowRuns.cancelRequested} = 1)`,
            ),
          )
          .orderBy(asc(workflowRuns.id))
          .all()
          .map(workflowRunRow),
      ),
      findRun: (runId) =>
        database.use('find_workflow_run', (db) => {
          const row = db
            .select(runColumns)
            .from(workflowRuns)
            .where(eq(workflowRuns.id, runId))
            .get();
          return row ? workflowRunRow(row) : null;
        }),
      findLatestRootRunForSurface: (surfaceId) =>
        database.use('find_latest_root_workflow_run_for_surface', (db) => {
          const row = db
            .select(runColumns)
            .from(workflowRuns)
            .where(
              and(eq(workflowRuns.surfaceId, surfaceId), sql`${workflowRuns.parentRunId} IS NULL`),
            )
            .orderBy(sql`${workflowRuns.id} DESC`)
            .get();
          return row ? workflowRunRow(row) : null;
        }),
      listRuns: (filters) =>
        database.use('list_workflow_runs', (db) => {
          const clauses = [];
          if (filters.surfaceId !== undefined) {
            clauses.push(eq(workflowRuns.surfaceId, filters.surfaceId));
          }
          if (filters.worktreeId !== undefined) {
            clauses.push(eq(workflowRuns.worktreeId, filters.worktreeId));
          }
          if (filters.status !== undefined) {
            clauses.push(eq(workflowRuns.status, filters.status));
          }
          if (filters.rootOnly ?? true) {
            clauses.push(sql`${workflowRuns.parentRunId} IS NULL`);
          }
          const query = db.select(runColumns).from(workflowRuns);
          const rows =
            clauses.length > 0
              ? query
                  .where(and(...clauses))
                  .orderBy(asc(workflowRuns.id))
                  .all()
              : query.orderBy(asc(workflowRuns.id)).all();
          return rows.map(workflowRunRow);
        }),
      listSurfaceDeletedRootRuns: database.use('list_surface_deleted_workflow_root_runs', (db) =>
        db
          .select(runColumns)
          .from(workflowRuns)
          .where(
            and(sql`${workflowRuns.surfaceId} IS NULL`, sql`${workflowRuns.parentRunId} IS NULL`),
          )
          .orderBy(asc(workflowRuns.id))
          .all()
          .map(workflowRunRow),
      ),
      listRunTree: (rootRunId) =>
        database.use('list_workflow_run_tree', (db) =>
          db
            .select(runColumns)
            .from(workflowRuns)
            .where(eq(workflowRuns.rootRunId, rootRunId))
            .orderBy(asc(workflowRuns.id))
            .all()
            .map(workflowRunRow),
        ),
      pauseNonTerminalRuns: database
        .transaction('pause_non_terminal_workflow_runs', (db) =>
          db
            .update(workflowRuns)
            .set({
              status: sql`CASE WHEN ${workflowRuns.status} = 'running' THEN 'ready' ELSE ${workflowRuns.status} END`,
              paused: true,
              owner: null,
              updatedAt: timestamp(),
            })
            .where(sql`${workflowRuns.status} IN ('waiting', 'ready', 'running')`)
            .returning(runColumns)
            .all()
            .map(workflowRunRow),
        )
        .pipe(
          Effect.tap((runs) =>
            Effect.all(
              runs.map((run) => publishWorkflowRunTouched(eventBus, run)),
              {
                discard: true,
              },
            ),
          ),
          Effect.map((runs) => runs.length),
        ),
      setPausedForRunTree: (input) =>
        database
          .transaction('set_paused_for_workflow_run_tree', (db) =>
            db
              .update(workflowRuns)
              .set({ paused: input.paused, owner: null, updatedAt: timestamp() })
              .where(
                and(
                  eq(workflowRuns.rootRunId, input.rootRunId),
                  sql`${workflowRuns.status} NOT IN ('done', 'failed')`,
                ),
              )
              .returning(runColumns)
              .all()
              .map(workflowRunRow),
          )
          .pipe(
            Effect.tap((runs) =>
              Effect.all(
                runs.map((run) => publishWorkflowRunTouched(eventBus, run)),
                {
                  discard: true,
                },
              ),
            ),
          ),
      requestCancelForRunTree: (rootRunId) =>
        database.transaction('request_cancel_for_workflow_run_tree', (db) =>
          db
            .update(workflowRuns)
            .set({ cancelRequested: true, updatedAt: timestamp() })
            .where(
              and(
                eq(workflowRuns.rootRunId, rootRunId),
                sql`${workflowRuns.status} NOT IN ('done', 'failed')`,
              ),
            )
            .returning(runColumns)
            .all()
            .map(workflowRunRow),
        ),
      deleteRunTree: (input) =>
        database
          .transaction('delete_workflow_run_tree', (db) => {
            const deleted = db
              .delete(workflowRuns)
              .where(eq(workflowRuns.rootRunId, input.rootRunId))
              .run();
            return deleted.changes;
          })
          .pipe(
            Effect.tap(() =>
              publishWorkflowRunRecompute(eventBus, {
                rootRunId: input.rootRunId,
                surfaceId: input.surfaceId,
              }),
            ),
          ),
      retryFailedRun: (runId) =>
        database
          .transaction('retry_failed_workflow_run', (db) => {
            const row = db
              .update(workflowRuns)
              .set({
                status: 'ready',
                paused: false,
                cancelRequested: false,
                owner: null,
                error: null,
                updatedAt: timestamp(),
              })
              .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, 'failed')))
              .returning(runColumns)
              .get();
            return row ? workflowRunRow(row) : null;
          })
          .pipe(
            Effect.tap((run) => (run ? publishWorkflowRunTouched(eventBus, run) : Effect.void)),
          ),
      claimReadyRun: (input) =>
        database
          .use('claim_ready_workflow_run', (db) => {
            const row = db
              .update(workflowRuns)
              .set({ status: 'running', owner: input.owner, updatedAt: timestamp() })
              .where(
                and(
                  eq(workflowRuns.id, input.runId),
                  eq(workflowRuns.status, 'ready'),
                  eq(workflowRuns.paused, false),
                  eq(workflowRuns.cancelRequested, false),
                ),
              )
              .returning(runColumns)
              .get();
            return row ? workflowRunRow(row) : null;
          })
          .pipe(
            Effect.tap((run) => (run ? publishWorkflowRunTouched(eventBus, run) : Effect.void)),
          ),
      findWaitingAgentTurnRuns: (agentSessionId) =>
        database.use('find_waiting_agent_turn_workflow_runs', (db) =>
          db
            .select(runColumns)
            .from(workflowRuns)
            .where(
              and(
                eq(workflowRuns.status, 'waiting'),
                eq(workflowRuns.waitKind, 'agent_turn'),
                sql`json_extract(${workflowRuns.waitCondition}, '$.agentSessionId') = ${agentSessionId}`,
              ),
            )
            .orderBy(asc(workflowRuns.id))
            .all()
            .map(workflowRunRow),
        ),
      findWaitingWorkflowRuns: (childRunId) =>
        database.use('find_waiting_workflow_runs', (db) =>
          db
            .select(runColumns)
            .from(workflowRuns)
            .where(
              and(
                eq(workflowRuns.status, 'waiting'),
                eq(workflowRuns.waitKind, 'workflow'),
                sql`EXISTS (SELECT 1 FROM json_each(${workflowRuns.waitCondition}, '$.runIds') WHERE json_each.value = ${childRunId})`,
              ),
            )
            .orderBy(asc(workflowRuns.id))
            .all()
            .map(workflowRunRow),
        ),
      resolveWorkflowJoin: (condition) =>
        database.use('resolve_workflow_join', (db) => {
          const results: WorkflowJoinResult[] = [];
          for (const runId of condition.runIds) {
            const row = db
              .select(runColumns)
              .from(workflowRuns)
              .where(eq(workflowRuns.id, runId))
              .get();
            if (!row) return { status: 'missing', runId } satisfies WorkflowJoinResolution;
            if (row.status !== 'done' && row.status !== 'failed') {
              return { status: 'pending' } satisfies WorkflowJoinResolution;
            }
            results.push({
              runId,
              status: row.status,
              result: row.status === 'done' ? parseOptionalJson(row.resultJson) : undefined,
              error:
                row.status === 'failed'
                  ? (parseOptionalJson(row.error) as WorkflowRunErrorPayload | undefined)
                  : undefined,
            });
          }
          return { status: 'complete', results } satisfies WorkflowJoinResolution;
        }),
      wakeWaitingRun: (input) =>
        database
          .transaction('wake_waiting_workflow_run', (db) => {
            const row = db
              .update(workflowRuns)
              .set({
                status: 'ready',
                waitKind: null,
                waitCondition: null,
                resumePayload: json(input.resumePayload),
                owner: null,
                updatedAt: timestamp(),
              })
              .where(
                and(
                  eq(workflowRuns.id, input.runId),
                  eq(workflowRuns.status, 'waiting'),
                  eq(workflowRuns.cancelRequested, false),
                ),
              )
              .returning(runColumns)
              .get();
            return row ? workflowRunRow(row) : null;
          })
          .pipe(
            Effect.tap((run) => (run ? publishWorkflowRunTouched(eventBus, run) : Effect.void)),
            Effect.map(Boolean),
          ),
      readyPausedRun: (input) =>
        database
          .transaction('ready_paused_workflow_run', (db) => {
            const update =
              input.resumePayload === undefined
                ? {
                    status: 'ready' as const,
                    paused: false,
                    waitKind: null,
                    waitCondition: null,
                    owner: null,
                    updatedAt: timestamp(),
                  }
                : {
                    status: 'ready' as const,
                    paused: false,
                    waitKind: null,
                    waitCondition: null,
                    resumePayload: json(input.resumePayload),
                    owner: null,
                    updatedAt: timestamp(),
                  };
            const row = db
              .update(workflowRuns)
              .set(update)
              .where(
                and(
                  eq(workflowRuns.id, input.runId),
                  sql`${workflowRuns.status} NOT IN ('done', 'failed')`,
                  eq(workflowRuns.cancelRequested, false),
                ),
              )
              .returning(runColumns)
              .get();
            return row ? workflowRunRow(row) : null;
          })
          .pipe(
            Effect.tap((run) => (run ? publishWorkflowRunTouched(eventBus, run) : Effect.void)),
            Effect.map(Boolean),
          ),
      rearmPausedRun: (runId) =>
        database
          .transaction('rearm_paused_workflow_run', (db) => {
            const row = db
              .update(workflowRuns)
              .set({
                status: 'waiting',
                paused: false,
                resumePayload: null,
                owner: null,
                updatedAt: timestamp(),
              })
              .where(
                and(
                  eq(workflowRuns.id, runId),
                  sql`${workflowRuns.status} NOT IN ('done', 'failed')`,
                  eq(workflowRuns.cancelRequested, false),
                  sql`${workflowRuns.waitKind} IS NOT NULL`,
                ),
              )
              .returning(runColumns)
              .get();
            return row ? workflowRunRow(row) : null;
          })
          .pipe(
            Effect.tap((run) => (run ? publishWorkflowRunTouched(eventBus, run) : Effect.void)),
            Effect.map(Boolean),
          ),
      completeCont: (input) =>
        database
          .transaction('complete_workflow_cont', (db) => {
            const now = timestamp();
            const stateJson = json(input.state);
            const row = db
              .update(workflowRuns)
              .set({
                status: 'ready',
                waitKind: null,
                waitCondition: null,
                resumePayload: null,
                stateJson,
                owner: null,
                error: null,
                updatedAt: now,
              })
              .where(and(eq(workflowRuns.id, input.runId), eq(workflowRuns.status, 'running')))
              .returning(runColumns)
              .get();
            if (!row) return null;
            insertRunEvent(db, {
              workflowRunId: input.runId,
              recordedAt: now,
              stateJson,
              trigger: { kind: 'cont' },
            });
            return workflowRunRow(row);
          })
          .pipe(
            Effect.tap((run) => (run ? publishWorkflowRunTouched(eventBus, run) : Effect.void)),
            Effect.asVoid,
          ),
      completeSuspend: (input) =>
        database
          .transaction('complete_workflow_suspend', (db) => {
            const now = timestamp();
            const stateJson = json(input.state);
            const row = db
              .update(workflowRuns)
              .set({
                status: 'waiting',
                waitKind: input.waitKind,
                waitCondition: json(input.waitCondition),
                resumePayload: null,
                stateJson,
                owner: null,
                error: null,
                updatedAt: now,
              })
              .where(and(eq(workflowRuns.id, input.runId), eq(workflowRuns.status, 'running')))
              .returning(runColumns)
              .get();
            if (!row) return null;
            insertRunEvent(db, {
              workflowRunId: input.runId,
              recordedAt: now,
              stateJson,
              trigger: { kind: 'suspend', waitKind: input.waitKind },
            });
            return workflowRunRow(row);
          })
          .pipe(
            Effect.tap((run) => (run ? publishWorkflowRunTouched(eventBus, run) : Effect.void)),
            Effect.asVoid,
          ),
      completeDone: (input) =>
        database
          .transaction('complete_workflow_done', (db) => {
            const now = timestamp();
            const hasValue = input.value !== undefined;
            const row = db
              .update(workflowRuns)
              .set({
                status: 'done',
                waitKind: null,
                waitCondition: null,
                resumePayload: null,
                owner: null,
                error: null,
                resultJson: hasValue ? json(input.value) : null,
                updatedAt: now,
              })
              .where(and(eq(workflowRuns.id, input.runId), eq(workflowRuns.status, 'running')))
              .returning(runColumns)
              .get();
            if (!row) return null;
            insertRunEvent(db, {
              workflowRunId: input.runId,
              recordedAt: now,
              stateJson: stateSnapshotJson({ state: input.state }),
              trigger: { kind: 'done', hasValue },
            });
            return workflowRunRow(row);
          })
          .pipe(
            Effect.tap((run) => (run ? publishWorkflowRunTouched(eventBus, run) : Effect.void)),
            Effect.asVoid,
          ),
      failRun: (input) =>
        database
          .transaction('fail_workflow_run', (db) => {
            const now = timestamp();
            const row = db
              .update(workflowRuns)
              .set({
                status: 'failed',
                waitKind: null,
                waitCondition: null,
                // Preserve `resumePayload` (the event that drove the throwing step)
                // so `retry` can re-run the failed step from snapshot with the same
                // event in hand — a resume-driven step must still see its turn edge /
                // user answers / join results on re-run, not `undefined`.
                owner: null,
                error: json(input.error),
                updatedAt: now,
              })
              .where(and(eq(workflowRuns.id, input.runId), eq(workflowRuns.status, 'running')))
              .returning(runColumns)
              .get();
            if (!row) return null;
            insertRunEvent(db, {
              workflowRunId: input.runId,
              recordedAt: now,
              stateJson: stateSnapshotJson(input.stateSnapshot),
              trigger: { kind: 'fail', thrown: input.thrown },
            });
            return workflowRunRow(row);
          })
          .pipe(
            Effect.tap((run) => (run ? publishWorkflowRunTouched(eventBus, run) : Effect.void)),
            Effect.asVoid,
          ),
      failNonTerminalRun: (input) =>
        database
          .transaction('fail_non_terminal_workflow_run', (db) => {
            const now = timestamp();
            const row = db
              .update(workflowRuns)
              .set({
                status: 'failed',
                paused: false,
                cancelRequested: false,
                waitKind: null,
                waitCondition: null,
                // Preserve `resumePayload` for the same reason as `failRun`: a later
                // `retry` re-runs the failed step from snapshot and must still see the
                // event that drove it.
                owner: null,
                error: json(input.error),
                updatedAt: now,
              })
              .where(
                and(
                  eq(workflowRuns.id, input.runId),
                  sql`${workflowRuns.status} NOT IN ('done', 'failed')`,
                ),
              )
              .returning(runColumns)
              .get();
            if (!row) return null;
            insertRunEvent(db, {
              workflowRunId: input.runId,
              recordedAt: now,
              stateJson: stateSnapshotJson(input.stateSnapshot),
              trigger: { kind: 'fail', thrown: input.thrown },
            });
            return workflowRunRow(row);
          })
          .pipe(
            Effect.tap((run) => (run ? publishWorkflowRunTouched(eventBus, run) : Effect.void)),
            Effect.asVoid,
          ),
    } satisfies WorkflowRepositoryService;
  }),
);

function workflowRunRow(row: WorkflowRunRecord): WorkflowRunRow {
  return {
    id: row.id,
    workflowKey: row.workflowKey,
    workflowTitle: row.workflowTitle,
    workflowArtifactHash: row.workflowArtifactHash,
    worktreeId: row.worktreeId,
    surfaceId: row.surfaceId,
    parentRunId: row.parentRunId,
    rootRunId: row.rootRunId,
    status: row.status as WorkflowStatus,
    paused: row.paused,
    cancelRequested: row.cancelRequested,
    waitKind: row.waitKind,
    waitCondition: row.waitCondition,
    resumePayload: row.resumePayload,
    stateJson: row.stateJson,
    stateVersion: row.stateVersion,
    owner: row.owner,
    error: row.error,
    resultJson: row.resultJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function publishWorkflowRunTouched(
  eventBus: import('../runtime-events/index.js').InternalRuntimeEventBusService,
  run: Pick<WorkflowRunRow, 'id' | 'rootRunId' | 'surfaceId'>,
) {
  return eventBus.publish({
    type: 'workflow_run_touched',
    runId: run.id,
    rootRunId: run.rootRunId,
    surfaceId: run.surfaceId,
  });
}

function publishWorkflowRunRecompute(
  eventBus: import('../runtime-events/index.js').InternalRuntimeEventBusService,
  input: { readonly rootRunId: number; readonly surfaceId: number | null },
) {
  return eventBus.publish({
    type: 'workflow_run_recompute_requested',
    rootRunId: input.rootRunId,
    surfaceId: input.surfaceId,
  });
}

function insertRunEvent(
  db: Parameters<Parameters<RuntimeDatabaseService['transaction']>[1]>[0],
  input: {
    readonly workflowRunId: number;
    readonly recordedAt: string;
    readonly stateJson: string;
    readonly trigger: WorkflowRunEventTrigger;
  },
) {
  db.insert(workflowRunEvents)
    .values({
      workflowRunId: input.workflowRunId,
      recordedAt: input.recordedAt,
      state: input.stateJson,
      trigger: json(input.trigger),
    })
    .run();
}

function stateSnapshotJson(input: WorkflowStateSnapshotInput) {
  return 'stateJson' in input ? input.stateJson : json(input.state);
}

function json(value: unknown) {
  return JSON.stringify(value);
}

function parseOptionalJson(value: string | null) {
  return value === null ? undefined : (JSON.parse(value) as unknown);
}

function timestamp() {
  return new Date().toISOString();
}
