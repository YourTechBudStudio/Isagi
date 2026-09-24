import { Effect } from 'effect';

import type { CheckpointCaptureFailureReason } from '../../checkpoints/failure.js';
import { normalizeCheckpointPlan } from '../../checkpoints/plan.js';
import type {
  WorkflowCheckpointRecord,
  WorkflowExecutionRecord,
} from '../../persistence/records.js';
import { isolate } from '../../state/isolation.js';
import { evaluatePure } from '../../state/pure.js';
import { edgeFromNode, nodeOf } from '../structure.js';
import {
  fenceOf,
  frameState,
  outcomeOfCommit,
  positionOf,
  recordSegmentFailure,
  requireFrame,
  segmentFailure,
  type EngineDeps,
  type SegmentFailure,
  type SegmentContext,
  type SegmentFault,
  type SegmentOutcome,
} from './shared.js';

/**
 * One checkpoint visit: save the declared scopes of the destination as one immutable checkpoint,
 * then route along the node's single edge with state unchanged.
 *
 * The order is what keeps every failure honest:
 *
 * 1. Every structural fact — graph, node, edge — and the frame state are resolved first, so a
 *    structural failure never leaves a checkpoint behind.
 * 2. The receipt is read before any author code. The checkpoint row commits in its own transaction
 *    before the segment's commit, so a process that died between the two left a row; this visit
 *    commits that row rather than capturing twice, and `prepare` does not run again.
 * 3. The run's destination is checked, then `prepare` runs against a frozen copy of the state and
 *    its plan is normalized. Both refuse before a byte is published.
 * 4. The capture service saves the files and commits the row, or refuses with a named reason and
 *    leaves no row. Database faults are not author failures; they propagate and stop the segment.
 */
export function runCheckpoint(
  deps: EngineDeps,
  ctx: SegmentContext,
  execution: WorkflowExecutionRecord,
): Effect.Effect<SegmentOutcome, SegmentFault> {
  const position = positionOf(ctx, 'node_callback');
  return Effect.gen(function* () {
    const frame = yield* requireFrame(deps, position.frameId);
    const graph = ctx.artifact.graphs.get(frame.graphKey);
    if (!graph) {
      return yield* Effect.fail(
        captureFailed(
          'graph_not_declared',
          `Graph '${frame.graphKey}' is not declared by the pinned artifact, so checkpoint '${execution.nodeId}' cannot run.`,
          { graphKey: frame.graphKey, artifactHash: ctx.run.artifactHash },
        ),
      );
    }
    const node = nodeOf(graph, execution.nodeId);
    if (!node || node.isagiKind !== 'checkpoint-node') {
      // The execution row says checkpoint, and the pinned graph disagrees. Failing here, rather
      // than running whatever the pin now holds, keeps a checkpoint visit from becoming an
      // operation by accident.
      return yield* Effect.fail(
        segmentFailure({
          code: 'unsupported_node_kind',
          message: node
            ? `Node '${execution.nodeId}' is a ${node.isagiKind.replace('-node', '')} node and cannot be executed as a checkpoint.`
            : `Node '${execution.nodeId}' is not declared by graph '${frame.graphKey}' in the pinned artifact.`,
          detail: { nodeId: execution.nodeId, kind: node?.isagiKind ?? null },
        }),
      );
    }
    const edge = edgeFromNode(graph, execution.nodeId);
    if (!edge) {
      return yield* Effect.fail(
        captureFailed(
          'edge_not_declared',
          `Graph '${graph.key}' no longer declares exactly one edge leaving checkpoint '${execution.nodeId}', so this visit has nowhere to route.`,
          { graphKey: graph.key, nodeId: execution.nodeId },
        ),
      );
    }
    // The single committed boundary this segment runs against, read once: `prepare` sees it, and
    // both commit paths re-commit it unchanged.
    const state = yield* frameState(deps, frame);

    const commit = (record: WorkflowCheckpointRecord) =>
      deps.runs
        .commitNodeResult({
          ...fenceOf(deps, ctx),
          frameId: frame.id,
          executionId: execution.id,
          state: { value: state },
          producerOutput: { value: { type: 'complete', checkpointId: record.checkpointKey } },
          // The pin that produced the checkpoint. On a receipt reuse that is the record's own, the
          // way a reused operation result keeps its producer's pin rather than the retry's.
          producerArtifactHash: record.artifactHash,
          next: { kind: 'routing', edgeId: edge.id },
        })
        .pipe(Effect.map(outcomeOfCommit));

    const existing = yield* deps.checkpoints.findByExecution(execution.id);
    if (existing) return yield* commit(existing);

    const destination = ctx.run.destination;
    if (destination.worktreeId === null || destination.worktreePath === null) {
      return yield* Effect.fail(
        captureFailed(
          'destination_unavailable',
          `Run ${ctx.run.id} has no destination worktree, so checkpoint '${execution.nodeId}' has nothing to capture.`,
        ),
      );
    }

    // No serializability gate: the returned plan is never stored as returned. Normalization reads
    // only the fields a plan has and refuses anything malformed, so an optional field an author
    // set to `undefined` — which the SDK types allow — is simply absent.
    const evaluated = evaluatePure({
      what: `Checkpoint '${execution.nodeId}' prepare`,
      failureCode: 'checkpoint_prepare_failed',
      run: () => node.prepare(isolate(state)),
    });
    if (!evaluated.ok) return yield* Effect.fail(segmentFailure(evaluated.failure));
    const plan = normalizeCheckpointPlan(evaluated.value, {
      nodeId: execution.nodeId,
      title: node.title,
    });
    if (!plan.ok) {
      return yield* Effect.fail(
        segmentFailure({
          code: 'checkpoint_prepare_failed',
          message: `Checkpoint '${execution.nodeId}' prepare returned a plan that was refused: ${plan.reason}.`,
          detail: { ...plan.detail, reason: plan.reason },
        }),
      );
    }

    const record = yield* deps.checkpointCapture
      .capture({
        runId: ctx.run.id,
        frameId: frame.id,
        executionId: execution.id,
        attemptId: ctx.attempt.id,
        artifactHash: ctx.run.artifactHash,
        nodeId: execution.nodeId,
        worktreeId: destination.worktreeId,
        plan: plan.value,
      })
      .pipe(
        Effect.catchTag('CheckpointCaptureFailure', (failure) =>
          Effect.fail(
            captureFailed(failure.reason, failure.message, {
              ...(failure.path === undefined ? {} : { path: failure.path }),
              ...(failure.scopeId === undefined ? {} : { scopeId: failure.scopeId }),
            }),
          ),
        ),
      );
    return yield* commit(record);
  }).pipe(Effect.catchTag('WorkflowSegmentFailure', recordSegmentFailure(deps, ctx)));
}

/** Every `checkpoint_capture_failed` names its reason, whether the segment or the service refused. */
function captureFailed(
  reason: CheckpointCaptureFailureReason,
  message: string,
  detail: Record<string, unknown> = {},
): SegmentFailure {
  return segmentFailure({
    code: 'checkpoint_capture_failed',
    message,
    detail: { ...detail, reason },
  });
}
