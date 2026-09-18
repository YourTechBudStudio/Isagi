import { and, desc, eq, lt } from 'drizzle-orm';

import type { WorkflowRunSummary, WorkflowTransitionKind } from '@isagi/contracts';

import type { RuntimeDrizzleDatabase } from '../../persistence/database.service.js';
import {
  workflowGraphFrames,
  workflowNodeExecutions,
  workflowOperations,
  workflowSegmentAttempts,
  workflowTransitionChanges,
  workflowWaits,
} from '../../persistence/schema.js';
import type { TransitionDraft } from '../persistence/history.repository.js';
import { projectExecution, projectFrame } from './project/graph.js';
import { projectOperation } from './project/records.js';
import { projectSummary } from './project/summary.js';

/**
 * Capturing what a committed transaction changed, while it is still committing.
 *
 * This is the one place the read model is written, and it runs inside the same transaction as the
 * transitions it describes — after that transaction's own mutations, so what it projects is the
 * state those mutations produced, and a rollback takes the snapshot with it.
 *
 * Why not project current rows later: an execution keeps changing as its attempts, wait, routing
 * and operations progress. Reading it at delivery time and attaching it to an old revision would
 * hand a reconnecting client a *future* state under a past revision, and the REST replay of a delta
 * would stop matching the live event the runtime already published. One durable representation
 * serves both paths instead.
 */

/** Which records a transaction's transitions changed, addressed by row id. */
interface ChangeSet {
  readonly frames: Set<number>;
  readonly executions: Set<number>;
  readonly operations: Set<number>;
}

/**
 * The one relation a transition's own identities do not already state.
 *
 * Every other kind names every record it changes: an attempt id reaches its execution or its frame,
 * an operation id reaches the execution whose summary it belongs to, a wait id reaches the visit
 * that armed it. A frame completing is the exception — the parent visit's status and its inline
 * child frame change with it, and the parent is named by no identity on that row.
 */
const relations: Record<WorkflowTransitionKind, { readonly parentExecutionOfFrame: boolean }> = {
  run_started: { parentExecutionOfFrame: false },
  // Preparation is frame-scoped and has no execution, so its transitions name every record they
  // change through the frame id they already carry.
  environment_step_recorded: { parentExecutionOfFrame: false },
  environment_prepared: { parentExecutionOfFrame: false },
  graph_entered: { parentExecutionOfFrame: false },
  node_dispatched: { parentExecutionOfFrame: false },
  wait_armed: { parentExecutionOfFrame: false },
  wait_delivered: { parentExecutionOfFrame: false },
  producer_output_captured: { parentExecutionOfFrame: false },
  state_reduced: { parentExecutionOfFrame: false },
  routed: { parentExecutionOfFrame: false },
  child_output_published: { parentExecutionOfFrame: false },
  output_mapped: { parentExecutionOfFrame: false },
  graph_completed: { parentExecutionOfFrame: true },
  run_completed: { parentExecutionOfFrame: false },
  segment_failed: { parentExecutionOfFrame: false },
  run_blocked: { parentExecutionOfFrame: false },
  operation_recorded: { parentExecutionOfFrame: false },
  operation_settled: { parentExecutionOfFrame: false },
  stop_recorded: { parentExecutionOfFrame: false },
  log: { parentExecutionOfFrame: false },
  ui_feedback: { parentExecutionOfFrame: false },
  pause_opened: { parentExecutionOfFrame: false },
  pause_closed: { parentExecutionOfFrame: false },
  retry_pin_adopted: { parentExecutionOfFrame: false },
  control_applied: { parentExecutionOfFrame: false },
};

/**
 * Writes the change snapshots for one `appendTransitions` call.
 *
 * The changed records are attached to the **last** revision the call allocated. A transaction that
 * writes several transitions commits them together, so its records have exactly one post-commit
 * state; the earlier revisions carry empty change arrays and the final one carries the projection.
 * Live publication and REST recovery both read this assignment, so they cannot disagree.
 *
 * The run summary is captured at *every* revision, because a point-in-time read at a frozen
 * high-water revision has to be able to answer "what did this run look like then" for any revision,
 * and `summary_changed` marks the ones a delta should actually carry.
 */
export function captureTransitionChanges(
  db: RuntimeDrizzleDatabase,
  runId: number,
  revisions: readonly number[],
  drafts: readonly TransitionDraft[],
): void {
  if (revisions.length === 0) return;
  const summary = projectSummary(db, runId);
  if (!summary) return;
  const previous = latestSummarySnapshot(db, runId, revisions[0]!);

  // A snapshot per revision, because a point-in-time read may be frozen at any of them — but only
  // the revision this transaction *ended* on is marked as a change to deliver. The earlier ones are
  // the same committed state seen from an earlier number, and attaching the summary to each of them
  // would make a client apply the transaction's outcome before it had applied the transaction.
  const changed = previous === null || differs(previous, summary);
  for (const [index, revision] of revisions.entries()) {
    writeChange(db, {
      runId,
      revision,
      recordKind: 'summary',
      recordId: 0,
      record: { ...summary, revision } satisfies WorkflowRunSummary,
      summaryChanged: changed && index === revisions.length - 1,
    });
  }

  const changes = changeSetOf(db, drafts);
  expandToAncestors(db, changes);
  const revision = revisions[revisions.length - 1]!;
  for (const frameId of changes.frames) {
    const frame = projectFrame(db, frameId);
    if (frame) {
      writeChange(db, { runId, revision, recordKind: 'frame', recordId: frameId, record: frame });
    }
  }
  for (const executionId of changes.executions) {
    const execution = projectExecution(db, executionId);
    if (execution) {
      writeChange(db, {
        runId,
        revision,
        recordKind: 'execution',
        recordId: executionId,
        record: execution,
      });
    }
  }
  for (const operationId of changes.operations) {
    const operation = projectOperation(db, operationId);
    if (operation) {
      writeChange(db, {
        runId,
        revision,
        recordKind: 'operation',
        recordId: operationId,
        record: operation,
      });
    }
  }
}

function changeSetOf(db: RuntimeDrizzleDatabase, drafts: readonly TransitionDraft[]): ChangeSet {
  const changes: ChangeSet = { frames: new Set(), executions: new Set(), operations: new Set() };
  for (const draft of drafts) {
    if (draft.frameId != null) changes.frames.add(draft.frameId);
    if (draft.executionId != null) changes.executions.add(draft.executionId);
    if (draft.operationId != null) {
      changes.operations.add(draft.operationId);
      const operation = db
        .select({ executionId: workflowOperations.executionId })
        .from(workflowOperations)
        .where(eq(workflowOperations.id, draft.operationId))
        .get();
      // An operation's settlement changes the summary of the visit that called it, which is what a
      // dock card and a node's capability set are drawn from.
      if (operation) changes.executions.add(operation.executionId);
    }
    if (draft.attemptId != null) {
      const attempt = db
        .select({
          executionId: workflowSegmentAttempts.executionId,
          frameId: workflowSegmentAttempts.frameId,
        })
        .from(workflowSegmentAttempts)
        .where(eq(workflowSegmentAttempts.id, draft.attemptId))
        .get();
      if (attempt) {
        // The two frame-owned segment kinds have no execution at all, and their attempt changes
        // what the frame shows instead.
        if (attempt.executionId === null) changes.frames.add(attempt.frameId);
        else changes.executions.add(attempt.executionId);
      }
    }
    if (draft.waitId != null) {
      const wait = db
        .select({ executionId: workflowWaits.executionId })
        .from(workflowWaits)
        .where(eq(workflowWaits.id, draft.waitId))
        .get();
      if (wait) changes.executions.add(wait.executionId);
    }
    if (relations[draft.kind].parentExecutionOfFrame && draft.frameId != null) {
      const frame = db
        .select({ parentExecutionId: workflowGraphFrames.parentExecutionId })
        .from(workflowGraphFrames)
        .where(eq(workflowGraphFrames.id, draft.frameId))
        .get();
      if (frame?.parentExecutionId != null) changes.executions.add(frame.parentExecutionId);
    }
  }
  return changes;
}

/**
 * A subgraph visit aggregates the work beneath it, so work beneath it changes *it*.
 *
 * Its record carries the child frame inline and counts the operations of its whole subtree — both
 * of which move when a nested frame gains an execution or a nested callback records an operation.
 * Without this the ancestor's snapshot would keep saying what was true when the subgraph was
 * entered, and a dock would report zero operations for a subgraph whose children had made a dozen
 * calls. Walking up is bounded by containment depth, which the verifier caps.
 */
function expandToAncestors(db: RuntimeDrizzleDatabase, changes: ChangeSet): void {
  const frames = new Set<number>(changes.frames);
  for (const executionId of changes.executions) {
    const execution = db
      .select({ frameId: workflowNodeExecutions.frameId })
      .from(workflowNodeExecutions)
      .where(eq(workflowNodeExecutions.id, executionId))
      .get();
    if (execution) frames.add(execution.frameId);
  }
  const seen = new Set<number>();
  for (const frameId of frames) {
    let current: number | undefined = frameId;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const frame: { parentExecutionId: number | null } | undefined = db
        .select({ parentExecutionId: workflowGraphFrames.parentExecutionId })
        .from(workflowGraphFrames)
        .where(eq(workflowGraphFrames.id, current))
        .get();
      if (!frame?.parentExecutionId) break;
      changes.executions.add(frame.parentExecutionId);
      const parent: { frameId: number } | undefined = db
        .select({ frameId: workflowNodeExecutions.frameId })
        .from(workflowNodeExecutions)
        .where(eq(workflowNodeExecutions.id, frame.parentExecutionId))
        .get();
      current = parent?.frameId;
    }
  }
}

function writeChange(
  db: RuntimeDrizzleDatabase,
  input: {
    readonly runId: number;
    readonly revision: number;
    readonly recordKind: 'summary' | 'frame' | 'execution' | 'operation';
    readonly recordId: number;
    readonly record: unknown;
    readonly summaryChanged?: boolean;
  },
): void {
  db.insert(workflowTransitionChanges)
    .values({
      runId: input.runId,
      revision: input.revision,
      recordKind: input.recordKind,
      recordId: input.recordId,
      recordJson: JSON.stringify(input.record),
      summaryChanged: input.summaryChanged ?? null,
    })
    .run();
}

function latestSummarySnapshot(
  db: RuntimeDrizzleDatabase,
  runId: number,
  beforeRevision: number,
): WorkflowRunSummary | null {
  const row = db
    .select()
    .from(workflowTransitionChanges)
    .where(
      and(
        eq(workflowTransitionChanges.runId, runId),
        eq(workflowTransitionChanges.recordKind, 'summary'),
        lt(workflowTransitionChanges.revision, beforeRevision),
      ),
    )
    .orderBy(desc(workflowTransitionChanges.revision))
    .get();
  return row ? (JSON.parse(row.recordJson) as WorkflowRunSummary) : null;
}

/**
 * Whether a summary says anything new.
 *
 * `revision` and `updatedAt` move with every transition by construction, so comparing them would
 * mark every receipt update as a summary change and attach a redundant summary to every delta.
 */
function differs(previous: WorkflowRunSummary, next: WorkflowRunSummary): boolean {
  const strip = ({ revision: _revision, updatedAt: _updatedAt, ...rest }: WorkflowRunSummary) =>
    JSON.stringify(rest);
  return strip(previous) !== strip(next);
}

export { relations as transitionChangeRelations };
