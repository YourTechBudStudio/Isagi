import { and, asc, eq, gt, lte, or, sql } from 'drizzle-orm';

import type {
  ListRunExecutionsOutput,
  WorkflowExecutionDto,
  WorkflowFrameDto,
  WorkflowOperationDto,
  WorkflowRecoveryBoundary,
} from '@isagi/contracts';

import type { RuntimeDrizzleDatabase } from '../../persistence/database.service.js';
import { workflowNodeExecutions, workflowTransitions } from '../../persistence/schema.js';
import {
  encodeCursor,
  encodeSnapshotToken,
  type CursorBinding,
  type CursorKey,
} from './cursors.js';
import { changedIds, recordsAt, summaryAt, summaryChangedWithin } from './snapshots.js';

/**
 * The run-scoped execution listing, which has two jobs and therefore two modes.
 *
 * **Hydration** draws a whole waterfall: every visit of the run on one clock, paged by row. **Gap
 * recovery** answers "what changed since the revision I last applied", and is paged by *revision*
 * instead — which is what lets its response report an honest partial coverage, and what bounds the
 * changed-record arrays, since a window's changes are as bounded as the window is.
 *
 * Both are taken at one frozen high-water revision, and both project from durable snapshots, so a
 * client can move from one to the other without the two views disagreeing about a single row.
 */

/**
 * Hydration: every visit of the run in `(startedAt, executionId)` order, as at the frozen boundary.
 *
 * The ordering key comes from the execution's own immutable columns — when it started and its id,
 * neither of which a later attempt can change — while every *fact* comes from the snapshot at the
 * boundary. Rows created after the freeze have no snapshot within it and are simply not part of this
 * view; they arrive as deltas after the coverage the response reports.
 */
export function baselineExecutions(
  db: RuntimeDrizzleDatabase,
  input: {
    readonly runId: number;
    readonly highWater: number;
    readonly limit: number;
    readonly binding: CursorBinding;
    readonly key: CursorKey | null;
  },
): ListRunExecutionsOutput {
  const rows = db
    .select({
      id: workflowNodeExecutions.id,
      startedAt: workflowNodeExecutions.startedAt,
      frameId: workflowNodeExecutions.frameId,
    })
    .from(workflowNodeExecutions)
    .where(
      and(
        eq(workflowNodeExecutions.runId, input.runId),
        ...(input.key === null
          ? []
          : [
              or(
                sql`${workflowNodeExecutions.startedAt} > ${String(input.key[0])}`,
                and(
                  eq(workflowNodeExecutions.startedAt, String(input.key[0])),
                  gt(workflowNodeExecutions.id, Number(input.key[1])),
                ),
              )!,
            ]),
      ),
    )
    .orderBy(asc(workflowNodeExecutions.startedAt), asc(workflowNodeExecutions.id))
    .limit(input.limit + 1)
    .all();

  const page = rows.slice(0, input.limit);
  const executions = recordsAt<WorkflowExecutionDto>(db, {
    runId: input.runId,
    kind: 'execution',
    ids: page.map((row) => row.id),
    atRevision: input.highWater,
  });
  const items = page
    .map((row) => executions.get(row.id))
    .filter((execution): execution is WorkflowExecutionDto => execution !== undefined);
  const frames = recordsAt<WorkflowFrameDto>(db, {
    runId: input.runId,
    kind: 'frame',
    ids: [...new Set(page.map((row) => row.frameId))],
    atRevision: input.highWater,
  });
  const last = page.at(-1);
  const complete = rows.length <= input.limit;
  return {
    items,
    nextCursor:
      complete || !last
        ? null
        : encodeCursor(input.binding, [last.startedAt, last.id], input.highWater),
    boundary: boundaryOf(input.runId, input.highWater, complete ? input.highWater : 0, complete),
    changes: {
      // The frames these rows belong to, so a page can be drawn without a second request. Operations
      // are deliberately absent: an execution carries its own operation summary, and the cards
      // themselves are fetched for the one visit a person selected.
      frames: [...frames.values()],
      operations: [],
    },
  };
}

/**
 * Gap recovery: what a window of revisions changed, paged by revision.
 *
 * Paging by revision rather than by row is what lets the response report an *honest partial*
 * coverage — the client may acknowledge exactly the revisions this page accounts for — and what
 * bounds the changed-record arrays, since a window's changes are as bounded as the window is.
 */
export function recoveredExecutions(
  db: RuntimeDrizzleDatabase,
  input: {
    readonly runId: number;
    readonly since: number;
    readonly highWater: number;
    readonly limit: number;
    readonly binding: CursorBinding;
    readonly key: CursorKey | null;
  },
): ListRunExecutionsOutput {
  const from = input.key === null ? input.since : Number(input.key[0]);
  const revisions = db
    .select({ revision: workflowTransitions.revision })
    .from(workflowTransitions)
    .where(
      and(
        eq(workflowTransitions.runId, input.runId),
        gt(workflowTransitions.revision, from),
        lte(workflowTransitions.revision, input.highWater),
      ),
    )
    .orderBy(asc(workflowTransitions.revision))
    .limit(input.limit)
    .all()
    .map((row) => row.revision);

  const coverage = revisions.at(-1) ?? from;
  const complete = coverage >= input.highWater;
  const window = { runId: input.runId, since: from, atRevision: coverage };
  const executionIds = changedIds(db, { ...window, kind: 'execution' });
  const frameIds = changedIds(db, { ...window, kind: 'frame' });
  const operationIds = changedIds(db, { ...window, kind: 'operation' });

  // Projected at the boundary, not at the revision that changed them: this response is a coherent
  // view at `coverage`, and the client applies it as one step forward to that revision.
  const executions = recordsAt<WorkflowExecutionDto>(db, {
    runId: input.runId,
    kind: 'execution',
    ids: executionIds,
    atRevision: coverage,
  });
  const frames = recordsAt<WorkflowFrameDto>(db, {
    runId: input.runId,
    kind: 'frame',
    ids: frameIds,
    atRevision: coverage,
  });
  const operations = recordsAt<WorkflowOperationDto>(db, {
    runId: input.runId,
    kind: 'operation',
    ids: operationIds,
    atRevision: coverage,
  });
  const summary = summaryChangedWithin(db, window) ? summaryAt(db, input.runId, coverage) : null;

  return {
    items: sortedByStart(db, [...executions.values()]),
    nextCursor: complete ? null : encodeCursor(input.binding, [coverage], input.highWater),
    boundary: boundaryOf(input.runId, input.highWater, coverage, complete),
    changes: {
      frames: [...frames.values()],
      operations: [...operations.values()],
      ...(summary === null ? {} : { summary }),
    },
  };
}

/** The same `(startedAt, executionId)` order the baseline uses, so both views agree. */
function sortedByStart(
  db: RuntimeDrizzleDatabase,
  executions: readonly WorkflowExecutionDto[],
): readonly WorkflowExecutionDto[] {
  return [...executions].sort((left, right) =>
    left.startedAt === right.startedAt
      ? left.executionId - right.executionId
      : left.startedAt < right.startedAt
        ? -1
        : 1,
  );
}

export function boundaryOf(
  runId: number,
  highWaterRevision: number,
  coverageRevision: number,
  complete: boolean,
): WorkflowRecoveryBoundary {
  return {
    highWaterRevision,
    // Never an acknowledgement of history this response did not carry: an incomplete recovery
    // reports only the revisions it actually delivered.
    coverageRevision: complete ? highWaterRevision : Math.min(coverageRevision, highWaterRevision),
    snapshotToken: encodeSnapshotToken(runId, highWaterRevision),
    complete,
  };
}
