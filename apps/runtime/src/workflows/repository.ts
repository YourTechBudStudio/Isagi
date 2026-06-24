import { and, asc, eq, getTableColumns, sql, type InferSelectModel } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import {
  DatabaseError,
  RuntimeDatabase,
  type RuntimeDatabaseService,
} from '../persistence/index.js';
import { workflowRunEvents, workflowRuns } from '../persistence/schema.js';
import type {
  WorkflowRunRow,
  WorkflowStatus,
  WorkflowUiFeedback,
  WorkflowWaitKind,
} from './types.js';

type WorkflowRunRecord = InferSelectModel<typeof workflowRuns>;

export interface WorkflowRepositoryService {
  readonly createRun: (input: {
    readonly workflowKey: string;
    readonly state: unknown;
    readonly stateVersion: number;
    readonly worktreeId?: number | null | undefined;
    readonly surfaceId?: number | null | undefined;
  }) => Effect.Effect<WorkflowRunRow, DatabaseError>;
  readonly listReadyRuns: Effect.Effect<WorkflowRunRow[], DatabaseError>;
  readonly findRun: (runId: number) => Effect.Effect<WorkflowRunRow | null, DatabaseError>;
  readonly pauseNonTerminalRuns: Effect.Effect<number, DatabaseError>;
  readonly setSurfaceId: (input: {
    readonly runId: number;
    readonly surfaceId: number;
  }) => Effect.Effect<void, DatabaseError>;
  readonly claimReadyRun: (input: {
    readonly runId: number;
    readonly owner: string;
  }) => Effect.Effect<WorkflowRunRow | null, DatabaseError>;
  readonly findWaitingTurnRuns: (input: {
    readonly agentSessionId: number;
    readonly harnessSessionId: string;
  }) => Effect.Effect<WorkflowRunRow[], DatabaseError>;
  readonly wakeWaitingRun: (input: {
    readonly runId: number;
    readonly resumePayload: WorkflowResumePayload;
  }) => Effect.Effect<boolean, DatabaseError>;
  readonly readyPausedRun: (input: {
    readonly runId: number;
    readonly resumePayload?: WorkflowResumePayload | undefined;
  }) => Effect.Effect<boolean, DatabaseError>;
  readonly rearmPausedTurnRun: (runId: number) => Effect.Effect<boolean, DatabaseError>;
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
  readonly setUiFeedback: (input: {
    readonly runId: number;
    readonly feedback: WorkflowUiFeedback;
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
  | { readonly outcome: 'failed'; readonly recordedAt: string; readonly reason: string };

export const WorkflowRepository = Context.GenericTag<WorkflowRepositoryService>(
  'isagi/WorkflowRepository',
);

export const WorkflowRepositoryLive = Layer.effect(
  WorkflowRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const runColumns = getTableColumns(workflowRuns);

    return {
      createRun: (input) =>
        database.use('create_workflow_run', (db) => {
          const now = timestamp();
          const inserted = db
            .insert(workflowRuns)
            .values({
              workflowKey: input.workflowKey,
              worktreeId: input.worktreeId ?? null,
              surfaceId: input.surfaceId ?? null,
              status: 'ready',
              waitKind: null,
              waitCondition: null,
              resumePayload: null,
              stateJson: json(input.state),
              stateVersion: input.stateVersion,
              owner: null,
              uiFeedback: null,
              error: null,
              resultJson: null,
              createdAt: now,
              updatedAt: now,
            })
            .returning(runColumns)
            .get();
          insertRunEvent(db, {
            workflowRunId: inserted.id,
            recordedAt: now,
            stateJson: json(input.state),
            trigger: { kind: 'initial' },
          });
          return workflowRunRow(inserted);
        }),
      listReadyRuns: database.use('list_ready_workflow_runs', (db) =>
        db
          .select(runColumns)
          .from(workflowRuns)
          .where(eq(workflowRuns.status, 'ready'))
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
      pauseNonTerminalRuns: database.transaction('pause_non_terminal_workflow_runs', (db) => {
        const rows = db
          .update(workflowRuns)
          .set({ status: 'paused', owner: null, updatedAt: timestamp() })
          .where(sql`${workflowRuns.status} IN ('waiting', 'ready', 'running')`)
          .returning({ id: workflowRuns.id })
          .all();
        return rows.length;
      }),
      setSurfaceId: (input) =>
        database.use('set_workflow_surface_id', (db) => {
          db.update(workflowRuns)
            .set({ surfaceId: input.surfaceId, updatedAt: timestamp() })
            .where(eq(workflowRuns.id, input.runId))
            .run();
        }),
      claimReadyRun: (input) =>
        database.use('claim_ready_workflow_run', (db) => {
          const row = db
            .update(workflowRuns)
            .set({ status: 'running', owner: input.owner, updatedAt: timestamp() })
            .where(and(eq(workflowRuns.id, input.runId), eq(workflowRuns.status, 'ready')))
            .returning(runColumns)
            .get();
          return row ? workflowRunRow(row) : null;
        }),
      findWaitingTurnRuns: (input) =>
        database.use('find_waiting_turn_workflow_runs', (db) =>
          db
            .select(runColumns)
            .from(workflowRuns)
            .where(
              and(
                eq(workflowRuns.status, 'waiting'),
                eq(workflowRuns.waitKind, 'turn'),
                sql`json_extract(${workflowRuns.waitCondition}, '$.agentSessionId') = ${input.agentSessionId}`,
                sql`json_extract(${workflowRuns.waitCondition}, '$.harnessSessionId') = ${input.harnessSessionId}`,
              ),
            )
            .orderBy(asc(workflowRuns.id))
            .all()
            .map(workflowRunRow),
        ),
      wakeWaitingRun: (input) =>
        database.transaction('wake_waiting_workflow_run', (db) => {
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
            .where(and(eq(workflowRuns.id, input.runId), eq(workflowRuns.status, 'waiting')))
            .returning({ id: workflowRuns.id })
            .get();
          return Boolean(row);
        }),
      readyPausedRun: (input) =>
        database.transaction('ready_paused_workflow_run', (db) => {
          const update =
            input.resumePayload === undefined
              ? {
                  status: 'ready' as const,
                  waitKind: null,
                  waitCondition: null,
                  owner: null,
                  updatedAt: timestamp(),
                }
              : {
                  status: 'ready' as const,
                  waitKind: null,
                  waitCondition: null,
                  resumePayload: json(input.resumePayload),
                  owner: null,
                  updatedAt: timestamp(),
                };
          const row = db
            .update(workflowRuns)
            .set(update)
            .where(and(eq(workflowRuns.id, input.runId), eq(workflowRuns.status, 'paused')))
            .returning({ id: workflowRuns.id })
            .get();
          return Boolean(row);
        }),
      rearmPausedTurnRun: (runId) =>
        database.transaction('rearm_paused_turn_workflow_run', (db) => {
          const row = db
            .update(workflowRuns)
            .set({
              status: 'waiting',
              resumePayload: null,
              owner: null,
              updatedAt: timestamp(),
            })
            .where(
              and(
                eq(workflowRuns.id, runId),
                eq(workflowRuns.status, 'paused'),
                eq(workflowRuns.waitKind, 'turn'),
              ),
            )
            .returning({ id: workflowRuns.id })
            .get();
          return Boolean(row);
        }),
      completeCont: (input) =>
        database.transaction('complete_workflow_cont', (db) => {
          const now = timestamp();
          const stateJson = json(input.state);
          db.update(workflowRuns)
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
            .where(eq(workflowRuns.id, input.runId))
            .run();
          insertRunEvent(db, {
            workflowRunId: input.runId,
            recordedAt: now,
            stateJson,
            trigger: { kind: 'cont' },
          });
        }),
      completeSuspend: (input) =>
        database.transaction('complete_workflow_suspend', (db) => {
          const now = timestamp();
          const stateJson = json(input.state);
          db.update(workflowRuns)
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
            .where(eq(workflowRuns.id, input.runId))
            .run();
          insertRunEvent(db, {
            workflowRunId: input.runId,
            recordedAt: now,
            stateJson,
            trigger: { kind: 'suspend', waitKind: input.waitKind },
          });
        }),
      completeDone: (input) =>
        database.transaction('complete_workflow_done', (db) => {
          const now = timestamp();
          const hasValue = input.value !== undefined;
          db.update(workflowRuns)
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
            .where(eq(workflowRuns.id, input.runId))
            .run();
          insertRunEvent(db, {
            workflowRunId: input.runId,
            recordedAt: now,
            stateJson: stateSnapshotJson({ state: input.state }),
            trigger: { kind: 'done', hasValue },
          });
        }),
      failRun: (input) =>
        database.transaction('fail_workflow_run', (db) => {
          const now = timestamp();
          db.update(workflowRuns)
            .set({
              status: 'failed',
              waitKind: null,
              waitCondition: null,
              resumePayload: null,
              owner: null,
              error: json(input.error),
              updatedAt: now,
            })
            .where(eq(workflowRuns.id, input.runId))
            .run();
          insertRunEvent(db, {
            workflowRunId: input.runId,
            recordedAt: now,
            stateJson: stateSnapshotJson(input.stateSnapshot),
            trigger: { kind: 'fail', thrown: input.thrown },
          });
        }),
      setUiFeedback: (input) =>
        database.use('set_workflow_ui_feedback', (db) => {
          db.update(workflowRuns)
            .set({ uiFeedback: json(input.feedback), updatedAt: timestamp() })
            .where(eq(workflowRuns.id, input.runId))
            .run();
        }),
    } satisfies WorkflowRepositoryService;
  }),
);

function workflowRunRow(row: WorkflowRunRecord): WorkflowRunRow {
  return {
    id: row.id,
    workflowKey: row.workflowKey,
    worktreeId: row.worktreeId,
    surfaceId: row.surfaceId,
    status: row.status as WorkflowStatus,
    waitKind: row.waitKind,
    waitCondition: row.waitCondition,
    resumePayload: row.resumePayload,
    stateJson: row.stateJson,
    stateVersion: row.stateVersion,
    owner: row.owner,
    uiFeedback: row.uiFeedback,
    error: row.error,
    resultJson: row.resultJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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

function timestamp() {
  return new Date().toISOString();
}
