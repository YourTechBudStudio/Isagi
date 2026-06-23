import { and, asc, eq, getTableColumns, type InferSelectModel } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import { DatabaseError, RuntimeDatabase } from '../persistence/index.js';
import { workflowRuns } from '../persistence/schema.js';
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
  readonly claimReadyRun: (input: {
    readonly runId: number;
    readonly owner: string;
  }) => Effect.Effect<WorkflowRunRow | null, DatabaseError>;
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
  readonly completeDone: (runId: number) => Effect.Effect<void, DatabaseError>;
  readonly failRun: (input: {
    readonly runId: number;
    readonly error: WorkflowRunErrorPayload;
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
              createdAt: now,
              updatedAt: now,
            })
            .returning(runColumns)
            .get();
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
      completeCont: (input) =>
        database.transaction('complete_workflow_cont', (db) => {
          db.update(workflowRuns)
            .set({
              status: 'ready',
              waitKind: null,
              waitCondition: null,
              resumePayload: null,
              stateJson: json(input.state),
              owner: null,
              error: null,
              updatedAt: timestamp(),
            })
            .where(eq(workflowRuns.id, input.runId))
            .run();
        }),
      completeSuspend: (input) =>
        database.transaction('complete_workflow_suspend', (db) => {
          db.update(workflowRuns)
            .set({
              status: 'waiting',
              waitKind: input.waitKind,
              waitCondition: json(input.waitCondition),
              resumePayload: null,
              stateJson: json(input.state),
              owner: null,
              error: null,
              updatedAt: timestamp(),
            })
            .where(eq(workflowRuns.id, input.runId))
            .run();
        }),
      completeDone: (runId) =>
        database.transaction('complete_workflow_done', (db) => {
          db.update(workflowRuns)
            .set({
              status: 'done',
              waitKind: null,
              waitCondition: null,
              resumePayload: null,
              owner: null,
              error: null,
              updatedAt: timestamp(),
            })
            .where(eq(workflowRuns.id, runId))
            .run();
        }),
      failRun: (input) =>
        database.transaction('fail_workflow_run', (db) => {
          db.update(workflowRuns)
            .set({
              status: 'failed',
              owner: null,
              error: json(input.error),
              updatedAt: timestamp(),
            })
            .where(eq(workflowRuns.id, input.runId))
            .run();
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function json(value: unknown) {
  return JSON.stringify(value);
}

function timestamp() {
  return new Date().toISOString();
}
