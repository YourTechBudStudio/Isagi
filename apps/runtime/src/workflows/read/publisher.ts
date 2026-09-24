import { asc, desc, gt } from 'drizzle-orm';
import { Cause, Context, Effect, Layer, Schedule } from 'effect';

import type { RuntimeEvent, WorkflowRunSummary } from '@isagi/contracts';

import type { RuntimeDrizzleDatabase } from '../../persistence/database.service.js';
import { RuntimeDatabase, type DatabaseError } from '../../persistence/index.js';
import { workflowTransitions } from '../../persistence/schema.js';
import {
  nextRuntimeEventEnvelope,
  RuntimeEventBus,
  type RuntimeEventBusService,
} from '../../runtime-events/event-bus.js';
import { WorkflowWriteWake } from '../persistence/write-wake.js';
import { deltaPage, recordsAt } from './snapshots.js';

/**
 * Publishing committed transitions, in order, after they commit.
 *
 * The publisher is a **drainer**, not an emitter wired into each write site. It keeps one cursor
 * over `workflow_transitions.id` — a single autoincrement the runtime's one serialized writer
 * allocates in commit order — and after every wake it publishes everything past that cursor. Three
 * properties fall out of that shape rather than out of discipline:
 *
 * - **Nothing is published that did not commit.** A rolled-back transaction leaves no row, and the
 *   wake it still sends finds nothing to send.
 * - **Order cannot invert.** Revisions are drained in insertion order, which for a per-run revision
 *   sequence is exactly revision order, so a client applying "last + 1" never sees a hole the
 *   runtime created.
 * - **A lost wake costs latency, not history.** The next wake drains from the same cursor, and a
 *   client that missed a notification recovers the identical deltas through the REST history route,
 *   because both read the same durable snapshots.
 */

export interface WorkflowDeltaPublisherService {
  /** Publishes everything committed past the cursor. Exposed so tests can drive it deterministically. */
  readonly drainOnce: Effect.Effect<number, DatabaseError>;
}

export const WorkflowDeltaPublisher = Context.GenericTag<WorkflowDeltaPublisherService>(
  'isagi/WorkflowDeltaPublisher',
);

/** How many transitions one drain pass publishes before yielding to the next. */
const drainBatchSize = 200;

export const WorkflowDeltaPublisherLive = Layer.scoped(
  WorkflowDeltaPublisher,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const bus = yield* RuntimeEventBus;
    const wake = yield* WorkflowWriteWake;

    // Starts at the history that already exists rather than republishing it. A client's first view
    // comes from the read routes; this stream carries what happens next.
    const startCursor = yield* database.use('workflow_publisher_cursor', highestTransitionId);
    const publisher = makeWorkflowDeltaPublisher(database, bus, startCursor);

    yield* Effect.forkScoped(
      Effect.forever(
        wake.awaitSignal.pipe(
          Effect.zipRight(
            publisher.drainOnce.pipe(
              // A database that briefly refuses a read must not strand the stream: the drain is
              // retried on its own, and a still-failing drain leaves the cursor untouched so the
              // next write's wake — or the delayed one below — picks the same work up again.
              Effect.retry(
                Schedule.exponential('50 millis').pipe(Schedule.compose(Schedule.recurs(4))),
              ),
              Effect.catchAllCause((cause) =>
                Effect.sync(() => {
                  console.error(
                    '[runtime] Workflow delta publication failed; retrying',
                    Cause.pretty(cause),
                  );
                }).pipe(
                  Effect.zipRight(
                    Effect.forkScoped(Effect.sleep('1 seconds').pipe(Effect.zipRight(wake.signal))),
                  ),
                  Effect.asVoid,
                ),
              ),
            ),
          ),
        ),
      ),
    );

    return publisher;
  }),
);

/**
 * The drainer itself, independent of how its dependencies are provided.
 *
 * `startCursor` is where publication begins: the live layer starts at the current end of history, a
 * test starts at zero to watch a whole run go past.
 */
export function makeWorkflowDeltaPublisher(
  database: Pick<import('../../persistence/index.js').RuntimeDatabaseService, 'use'>,
  bus: Pick<RuntimeEventBusService, 'publish'>,
  startCursor: number,
): WorkflowDeltaPublisherService {
  let cursor = startCursor;
  return {
    drainOnce: Effect.gen(function* () {
      let published = 0;
      for (;;) {
        const batch = yield* database.use('workflow_publisher_drain', (db) =>
          drainBatch(db, cursor),
        );
        if (batch.events.length === 0) return published;
        for (const event of batch.events) yield* bus.publish(event);
        cursor = batch.cursor;
        published += batch.events.length;
        if (!batch.hasMore) return published;
      }
    }),
  };
}

function highestTransitionId(db: RuntimeDrizzleDatabase): number {
  const row = db
    .select({ id: workflowTransitions.id })
    .from(workflowTransitions)
    .orderBy(desc(workflowTransitions.id))
    .get();
  return row?.id ?? 0;
}

/**
 * One pass: the next committed transitions, turned into the events a client applies.
 *
 * Consecutive rows of the same run are assembled through the shared delta core in one call, so a
 * live event and the same revision fetched from `/events` are produced by the same code from the
 * same durable snapshots.
 */
function drainBatch(
  db: RuntimeDrizzleDatabase,
  cursor: number,
): {
  readonly events: readonly RuntimeEvent[];
  readonly cursor: number;
  readonly hasMore: boolean;
} {
  const rows = db
    .select({
      id: workflowTransitions.id,
      runId: workflowTransitions.runId,
      revision: workflowTransitions.revision,
    })
    .from(workflowTransitions)
    .where(gt(workflowTransitions.id, cursor))
    .orderBy(asc(workflowTransitions.id))
    .limit(drainBatchSize)
    .all();
  if (rows.length === 0) return { events: [], cursor, hasMore: false };

  const events: RuntimeEvent[] = [];
  for (const group of groupConsecutiveRuns(rows)) {
    const deltas = deltaPage(db, {
      runId: group.runId,
      since: group.from - 1,
      atRevision: group.to,
      limit: group.to - group.from + 1,
    });
    for (const delta of deltas) {
      events.push({
        ...nextRuntimeEventEnvelope(),
        type: 'workflow_run_transition',
        payload: delta,
      });
      if (delta.changes.summary) {
        events.push(...surfaceBookkeeping(db, delta.changes.summary));
      }
    }
  }
  return {
    events,
    cursor: rows[rows.length - 1]!.id,
    hasMore: rows.length === drainBatchSize,
  };
}

/**
 * The two surface-level events, derived from the same summary the delta carries.
 *
 * They exist for bookkeeping — which runs a surface shows — and deliberately say nothing the
 * revision stream does not already say, so they cannot become a competing authority for a run's
 * state.
 */
function surfaceBookkeeping(
  db: RuntimeDrizzleDatabase,
  summary: WorkflowRunSummary,
): readonly RuntimeEvent[] {
  const events: RuntimeEvent[] = [
    { ...nextRuntimeEventEnvelope(), type: 'workflow_run_changed', payload: summary },
  ];
  if (summary.attachment === null) {
    const previous = recordsAt<WorkflowRunSummary>(db, {
      runId: summary.runId,
      kind: 'summary',
      ids: [0],
      atRevision: summary.revision - 1,
    }).get(0);
    // Detachment is an edge, not a state: it is published when this revision is the one that
    // released the attachment, so a terminal run does not re-announce it at every later transition.
    if (previous?.attachment) {
      events.push({
        ...nextRuntimeEventEnvelope(),
        type: 'workflow_run_detached',
        payload: { runId: summary.runId, surfaceId: previous.attachment.surfaceId },
      });
    }
  }
  return events;
}

function groupConsecutiveRuns(
  rows: readonly { readonly runId: number; readonly revision: number }[],
): readonly { readonly runId: number; readonly from: number; readonly to: number }[] {
  const groups: { runId: number; from: number; to: number }[] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && last.runId === row.runId && row.revision === last.to + 1) {
      last.to = row.revision;
      continue;
    }
    groups.push({ runId: row.runId, from: row.revision, to: row.revision });
  }
  return groups;
}
