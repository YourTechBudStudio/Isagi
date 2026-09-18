import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type { WorkflowTransitionKind } from '@isagi/contracts';

import type { RuntimeDrizzleDatabase } from '../../persistence/database.service.js';
import { DatabaseError, RuntimeDatabase } from '../../persistence/index.js';
import { workflowRuns, workflowTransitions } from '../../persistence/schema.js';
import { captureTransitionChanges } from '../read/capture.js';
import type { PayloadSlot } from './payload-store.js';
import type { WorkflowTransitionRecord } from './records.js';
import { transitionRecord } from './row-mappers.js';
import { slotColumns } from './slots.js';

/**
 * One transition to append, before it has a revision.
 *
 * A caller says what happened and which records it concerns; the revision is allocated here,
 * because allocating it anywhere else is how two writers end up with the same number.
 */
export interface TransitionDraft {
  readonly kind: WorkflowTransitionKind;
  readonly frameId?: number | null;
  readonly executionId?: number | null;
  readonly attemptId?: number | null;
  readonly operationId?: number | null;
  readonly waitId?: number | null;
  readonly artifactHash?: string | null;
  /** The post-transition frame state, where this transition committed one. */
  readonly state?: PayloadSlot | null;
  readonly detail?: PayloadSlot | null;
}

/**
 * Appends transitions inside an open transaction and advances the run's history cursor.
 *
 * Revisions are contiguous per run and unique, including when one transaction writes several: a
 * transaction appending three transitions takes `n+1`, `n+2`, `n+3` and leaves the run at `n+3`.
 * That contiguity is the whole protocol — a client applies a delta only when its revision is
 * exactly one past the last it applied, so a gap is indistinguishable from a lost message and a
 * reused number silently diverges two views of the same run.
 *
 * Nothing here publishes. The returned records are what a caller publishes **after** the
 * transaction commits, so an observer can never be told about a revision a crash rolled back.
 */
export function appendTransitions(
  db: RuntimeDrizzleDatabase,
  runId: number,
  drafts: readonly TransitionDraft[],
  now: string,
): readonly WorkflowTransitionRecord[] {
  if (drafts.length === 0) return [];
  const current = db
    .select({ revision: workflowRuns.revision })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .get();
  if (!current) throw new Error(`Cannot append history for unknown workflow run ${runId}.`);

  const written = drafts.map((draft, index) => {
    const state = slotColumns(draft.state);
    const detail = slotColumns(draft.detail);
    const row = db
      .insert(workflowTransitions)
      .values({
        runId,
        revision: current.revision + index + 1,
        recordedAt: now,
        kind: draft.kind,
        frameId: draft.frameId ?? null,
        executionId: draft.executionId ?? null,
        attemptId: draft.attemptId ?? null,
        operationId: draft.operationId ?? null,
        waitId: draft.waitId ?? null,
        artifactHash: draft.artifactHash ?? null,
        stateInline: state.inline,
        stateRef: state.ref,
        detailInline: detail.inline,
        detailRef: detail.ref,
      })
      .returning()
      .get();
    return transitionRecord(row);
  });

  db.update(workflowRuns)
    .set({ revision: current.revision + drafts.length, updatedAt: now })
    .where(eq(workflowRuns.id, runId))
    .run();

  // The read model is captured here, for the same reason revisions are allocated here: this is the
  // one point every durable workflow change passes through, so a delivery obligation attached to it
  // cannot be forgotten by a new write site. It runs after this transaction's own mutations and
  // inside the same transaction, so a rollback leaves neither history nor snapshot.
  captureTransitionChanges(
    db,
    runId,
    written.map((transition) => transition.revision),
    drafts,
  );

  return written;
}

export interface WorkflowHistoryPage {
  readonly transitions: readonly WorkflowTransitionRecord[];
  /**
   * The run's revision at the moment the page was read, frozen for this read.
   *
   * A caller reports coverage against this rather than against a revision it never saw, so a
   * completed recovery cannot acknowledge history that was still being written.
   */
  readonly highWaterRevision: number;
}

export interface WorkflowHistoryRepositoryService {
  /** Transitions strictly after `sinceRevision`, in revision order, bounded by `limit`. */
  readonly since: (input: {
    readonly runId: number;
    readonly sinceRevision: number;
    readonly limit: number;
  }) => Effect.Effect<WorkflowHistoryPage, DatabaseError>;
  readonly currentRevision: (runId: number) => Effect.Effect<number | null, DatabaseError>;
  readonly countForRun: (runId: number) => Effect.Effect<number, DatabaseError>;
}

export const WorkflowHistoryRepository = Context.GenericTag<WorkflowHistoryRepositoryService>(
  'isagi/WorkflowHistoryRepository',
);

export const WorkflowHistoryRepositoryLive = Layer.effect(
  WorkflowHistoryRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return makeWorkflowHistoryRepository(database);
  }),
);

export function makeWorkflowHistoryRepository(
  database: Pick<import('../../persistence/index.js').RuntimeDatabaseService, 'use'>,
): WorkflowHistoryRepositoryService {
  return {
    since: (input) =>
      database.use('workflow_read_history', (db) => {
        // The boundary is read first and every row is bounded by it, so a transition committed
        // while this page was being assembled is left for the next page rather than arriving
        // above a watermark that has not been acknowledged.
        const run = db
          .select({ revision: workflowRuns.revision })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, input.runId))
          .get();
        const highWaterRevision = run?.revision ?? 0;
        const rows = db
          .select()
          .from(workflowTransitions)
          .where(
            and(
              eq(workflowTransitions.runId, input.runId),
              gt(workflowTransitions.revision, input.sinceRevision),
              lte(workflowTransitions.revision, highWaterRevision),
            ),
          )
          .orderBy(asc(workflowTransitions.revision))
          .limit(input.limit)
          .all();
        return { transitions: rows.map(transitionRecord), highWaterRevision };
      }),
    currentRevision: (runId) =>
      database.use('workflow_read_run_revision', (db) => {
        const row = db
          .select({ revision: workflowRuns.revision })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, runId))
          .get();
        return row?.revision ?? null;
      }),
    countForRun: (runId) =>
      database.use('workflow_count_history', (db) => {
        const row = db
          .select({ count: sql<number>`count(*)` })
          .from(workflowTransitions)
          .where(eq(workflowTransitions.runId, runId))
          .get();
        return row?.count ?? 0;
      }),
  } satisfies WorkflowHistoryRepositoryService;
}
