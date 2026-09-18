import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';

import type {
  WorkflowExecutionDto,
  WorkflowFrameDto,
  WorkflowOperationDto,
  WorkflowRunSummary,
  WorkflowRunTransitionDelta,
} from '@isagi/contracts';

import type { RuntimeDrizzleDatabase } from '../../persistence/database.service.js';
import {
  workflowOperations,
  workflowTransitionChanges,
  workflowTransitions,
} from '../../persistence/schema.js';
import { transitionDto } from './project/records.js';

/**
 * Reading the durable read model.
 *
 * Every execution, frame, operation and summary a client receives comes from here: the snapshot a
 * committed transaction captured, selected as "the latest one at or before the revision this read
 * was frozen at". That single rule gives both halves of the contract at once — a baseline read is
 * coherent at its boundary, and a delta replayed from REST is byte-identical to the live event that
 * carried the same revision.
 *
 * Nothing in this module reads a mutable workflow row, so nothing here can hand back a state that
 * belongs to a revision the caller has not been given.
 */

export type SnapshotRecordKind = 'summary' | 'frame' | 'execution' | 'operation';

/**
 * The state of one set of records as at a revision.
 *
 * Bounded by construction: callers pass the ids of one page, never a whole run, and each id costs
 * one indexed lookup of its newest snapshot within the boundary.
 */
export function recordsAt<T>(
  db: RuntimeDrizzleDatabase,
  input: {
    readonly runId: number;
    readonly kind: SnapshotRecordKind;
    readonly ids: readonly number[];
    readonly atRevision: number;
  },
): Map<number, T> {
  const found = new Map<number, T>();
  for (const id of input.ids) {
    const row = db
      .select()
      .from(workflowTransitionChanges)
      .where(
        and(
          eq(workflowTransitionChanges.runId, input.runId),
          eq(workflowTransitionChanges.recordKind, input.kind),
          eq(workflowTransitionChanges.recordId, id),
          lte(workflowTransitionChanges.revision, input.atRevision),
        ),
      )
      .orderBy(desc(workflowTransitionChanges.revision))
      .get();
    if (row) found.set(id, JSON.parse(row.recordJson) as T);
  }
  return found;
}

export function summaryAt(
  db: RuntimeDrizzleDatabase,
  runId: number,
  atRevision: number,
): WorkflowRunSummary | null {
  return (
    recordsAt<WorkflowRunSummary>(db, {
      runId,
      kind: 'summary',
      ids: [0],
      atRevision,
    }).get(0) ?? null
  );
}

/** Record ids of one kind that any revision in `(since, at]` changed, in id order. */
export function changedIds(
  db: RuntimeDrizzleDatabase,
  input: {
    readonly runId: number;
    readonly kind: SnapshotRecordKind;
    readonly since: number;
    readonly atRevision: number;
  },
): readonly number[] {
  return db
    .selectDistinct({ recordId: workflowTransitionChanges.recordId })
    .from(workflowTransitionChanges)
    .where(
      and(
        eq(workflowTransitionChanges.runId, input.runId),
        eq(workflowTransitionChanges.recordKind, input.kind),
        gt(workflowTransitionChanges.revision, input.since),
        lte(workflowTransitionChanges.revision, input.atRevision),
      ),
    )
    .orderBy(asc(workflowTransitionChanges.recordId))
    .all()
    .map((row) => row.recordId);
}

/** Whether any revision in `(since, at]` reported a summary change worth delivering. */
export function summaryChangedWithin(
  db: RuntimeDrizzleDatabase,
  input: { readonly runId: number; readonly since: number; readonly atRevision: number },
): boolean {
  const row = db
    .select({ value: sql<number>`count(*)` })
    .from(workflowTransitionChanges)
    .where(
      and(
        eq(workflowTransitionChanges.runId, input.runId),
        eq(workflowTransitionChanges.recordKind, 'summary'),
        eq(workflowTransitionChanges.summaryChanged, true),
        gt(workflowTransitionChanges.revision, input.since),
        lte(workflowTransitionChanges.revision, input.atRevision),
      ),
    )
    .get();
  return (row?.value ?? 0) > 0;
}

/**
 * The deltas for a bounded window of revisions.
 *
 * This is the one change-discovery algorithm in the runtime: the publisher drains through it and the
 * `/events` route pages through it, so a live event and its REST replay are the same bytes. Each
 * delta carries the transition and every record that revision captured — empty arrays are normal,
 * because a transaction that wrote several transitions attaches its projection to the last of them.
 */
export function deltaPage(
  db: RuntimeDrizzleDatabase,
  input: {
    readonly runId: number;
    readonly since: number;
    readonly atRevision: number;
    readonly limit: number;
  },
): readonly WorkflowRunTransitionDelta[] {
  const transitions = db
    .select()
    .from(workflowTransitions)
    .where(
      and(
        eq(workflowTransitions.runId, input.runId),
        gt(workflowTransitions.revision, input.since),
        lte(workflowTransitions.revision, input.atRevision),
      ),
    )
    .orderBy(asc(workflowTransitions.revision))
    .limit(input.limit)
    .all();
  if (transitions.length === 0) return [];

  const revisions = transitions.map((transition) => transition.revision);
  const changes = db
    .select()
    .from(workflowTransitionChanges)
    .where(
      and(
        eq(workflowTransitionChanges.runId, input.runId),
        inArray(workflowTransitionChanges.revision, revisions),
      ),
    )
    .all();

  const byRevision = new Map<number, typeof changes>();
  for (const change of changes) {
    const bucket = byRevision.get(change.revision) ?? [];
    bucket.push(change);
    byRevision.set(change.revision, bucket);
  }

  return transitions.map((transition) => {
    const bucket = byRevision.get(transition.revision) ?? [];
    const summaryRow = bucket.find((change) => change.recordKind === 'summary');
    const summary =
      summaryRow && summaryRow.summaryChanged
        ? (JSON.parse(summaryRow.recordJson) as WorkflowRunSummary)
        : undefined;
    return {
      runId: input.runId,
      revision: transition.revision,
      transition: transitionDto(db, transition, operationKeyOf(db, transition.operationId)),
      changes: {
        executions: decodeKind<WorkflowExecutionDto>(bucket, 'execution'),
        frames: decodeKind<WorkflowFrameDto>(bucket, 'frame'),
        operations: decodeKind<WorkflowOperationDto>(bucket, 'operation'),
        ...(summary === undefined ? {} : { summary }),
      },
    } satisfies WorkflowRunTransitionDelta;
  });
}

function decodeKind<T>(
  bucket: readonly (typeof workflowTransitionChanges.$inferSelect)[],
  kind: SnapshotRecordKind,
): readonly T[] {
  return bucket
    .filter((change) => change.recordKind === kind)
    .sort((left, right) => left.recordId - right.recordId)
    .map((change) => JSON.parse(change.recordJson) as T);
}

/** A transition names an operation by row id; the wire names it by its opaque public key. */
function operationKeyOf(db: RuntimeDrizzleDatabase, operationId: number | null): string | null {
  if (operationId === null) return null;
  const row = db
    .select({ operationKey: workflowOperations.operationKey })
    .from(workflowOperations)
    .where(eq(workflowOperations.id, operationId))
    .get();
  return row?.operationKey ?? null;
}
