import { Effect } from 'effect';

import { isolate } from '../../state/isolation.js';
import { evaluatePure } from '../../state/pure.js';
import { isPlainObject, reduceState } from '../../state/reducers.js';
import type { SubgraphResult } from '../../types.js';
import { edgeFromNode, nodeOf } from '../structure.js';
import {
  fenceOf,
  frameState,
  outcomeOfCommit,
  positionOf,
  recordSegmentFailure,
  requireExecution,
  requireFrame,
  requireGraph,
  resolveSlot,
  segmentFailure,
  segmentIdentityOf,
  type EngineDeps,
  type SegmentContext,
  type SegmentFailure,
  type SegmentFault,
  type SegmentOutcome,
} from './shared.js';

/**
 * Mapping a completed child's published outcome back into its parent's state.
 *
 * The child is finished and its completion fact is immutable, so nothing here can re-run it: a
 * mapping that throws, and every retry of it, reads exactly the values the child published and the
 * version that produced them. And because routing is a separate committed position, a successful
 * mapping followed by a failed route does not re-apply the mapping.
 */
export function runOutputMapping(
  deps: EngineDeps,
  ctx: SegmentContext,
): Effect.Effect<SegmentOutcome, SegmentFault> {
  const position = positionOf(ctx, 'child_output_mapping');
  return Effect.gen(function* () {
    const parentFrame = yield* requireFrame(deps, position.frameId);
    const parentExecution = yield* requireExecution(deps, position.executionId);
    const graph = yield* requireGraph(ctx, parentFrame, 'output_mapping_failed');
    const node = nodeOf(graph, parentExecution.nodeId);
    if (!node || node.isagiKind !== 'subgraph-node') {
      return yield* Effect.fail(
        segmentFailure({
          code: 'output_mapping_failed',
          message: `Node '${parentExecution.nodeId}' in graph '${parentFrame.graphKey}' no longer registers a subgraph, but a completed child's output is waiting to be mapped through it.`,
          detail: { graphKey: parentFrame.graphKey, nodeId: parentExecution.nodeId },
        }),
      );
    }
    const edge = edgeFromNode(graph, parentExecution.nodeId);
    if (!edge) {
      return yield* Effect.fail(
        segmentFailure({
          code: 'output_mapping_failed',
          message: `Graph '${parentFrame.graphKey}' no longer declares exactly one edge leaving node '${parentExecution.nodeId}'.`,
          detail: { graphKey: parentFrame.graphKey, nodeId: parentExecution.nodeId },
        }),
      );
    }

    const parentState = yield* frameState(deps, parentFrame);
    const saved = yield* deps.runs.findProducerOutput(segmentIdentityOf(ctx.attempt));
    const update = saved
      ? yield* reuseMapping(deps, saved.slot)
      : yield* evaluateMapping(deps, {
          childFrameId: position.childFrameId,
          nodeId: parentExecution.nodeId,
          onResult: node.onResult,
          parentState,
        });
    const producerArtifactHash = saved?.producerArtifactHash ?? ctx.run.artifactHash;

    if (!saved) {
      yield* deps.runs.captureProducerOutput({
        ...fenceOf(deps, ctx),
        producerOutput: { value: { update: update.value } },
        producerArtifactHash,
      });
    }

    const reduced = reduceState({
      fields: graph.state,
      current: parentState,
      update: update.value,
      graphKey: parentFrame.graphKey,
    });
    if (!reduced.ok) return yield* Effect.fail(segmentFailure(reduced.failure));

    const committed = yield* deps.runs.commitOutputMapping({
      ...fenceOf(deps, ctx),
      parentFrameId: parentFrame.id,
      parentExecutionId: parentExecution.id,
      state: { value: reduced.state },
      producerOutput: { value: { update: update.value } },
      producerArtifactHash,
      edgeId: edge.id,
    });
    return outcomeOfCommit(committed);
  }).pipe(Effect.catchTag('WorkflowSegmentFailure', recordSegmentFailure(deps, ctx)));
}

function evaluateMapping(
  deps: EngineDeps,
  input: {
    readonly childFrameId: number;
    readonly nodeId: string;
    readonly onResult: (parent: never, result: SubgraphResult<unknown>) => unknown;
    readonly parentState: Record<string, unknown>;
  },
): Effect.Effect<{ readonly value: unknown }, SegmentFault | SegmentFailure> {
  return Effect.gen(function* () {
    const child = yield* requireFrame(deps, input.childFrameId);
    if (child.status !== 'completed' || child.outcomeId === null || child.outcomeKind === null) {
      return yield* Effect.fail(
        segmentFailure({
          code: 'output_mapping_failed',
          message: `Child frame ${child.id} has not published an outcome, so there is nothing to map.`,
        }),
      );
    }
    const output = yield* resolveSlot(deps, child.output, `Output of frame ${child.id}`);
    const result: SubgraphResult<unknown> = {
      outcomeId: child.outcomeId as SubgraphResult<unknown>['outcomeId'],
      outcomeKind: child.outcomeKind,
      ...(child.outcomeReason === null ? {} : { reason: child.outcomeReason }),
      output,
    };
    const mapped = evaluatePure({
      what: `Output mapping for node '${input.nodeId}'`,
      failureCode: 'output_mapping_failed',
      run: () => input.onResult(isolate(input.parentState) as never, isolate(result)),
      serializeAs: '',
    });
    if (!mapped.ok) return yield* Effect.fail(segmentFailure(mapped.failure));
    return { value: mapped.value };
  });
}

function reuseMapping(
  deps: EngineDeps,
  slot: NonNullable<Parameters<typeof resolveSlot>[1]>,
): Effect.Effect<{ readonly value: unknown }, SegmentFailure> {
  return resolveSlot(deps, slot, 'Saved output mapping').pipe(
    Effect.flatMap((value) =>
      isPlainObject(value)
        ? Effect.succeed({ value: value.update })
        : Effect.fail(
            segmentFailure({
              code: 'payload_unavailable',
              message: 'The saved output mapping for this segment is not a recognizable update.',
            }),
          ),
    ),
  );
}
