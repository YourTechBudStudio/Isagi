import { Effect } from 'effect';

import type { WorkflowFrameRecord } from '../../persistence/records.js';
import { isolate } from '../../state/isolation.js';
import { evaluatePure } from '../../state/pure.js';
import { assertDeclaredStateFields } from '../../state/reducers.js';
import type { AnyGraphDefinition } from '../../structure/loader.js';
import type { WorkflowDestination } from '../../types.js';
import { captureLabel } from '../labels.js';
import { graphOf, nodeKindOf, nodeOf, type AnyGraphNode } from '../structure.js';
import { recordLabelDiagnostic } from './diagnostics.js';
import {
  fenceOf,
  frameState,
  outcomeOfCommit,
  positionOf,
  recordSegmentFailure,
  requireFrame,
  resolveSlot,
  segmentFailure,
  type EngineDeps,
  type SegmentContext,
  type SegmentFailure,
  type SegmentFault,
  type SegmentOutcome,
} from './shared.js';

/**
 * Entering a graph: map the parameters, initialize the state, commit both.
 *
 * This is the one segment that captures no producer operand, and the asymmetry is deliberate. Both
 * callbacks are pure and neither crosses an external boundary, so an uncommitted failure can simply
 * evaluate them again — there is nothing a later attempt could reuse that it cannot recompute. Every
 * other segment either consumes an effect's result or produces a value published as a versioned
 * fact, which is what makes *their* operands worth saving.
 *
 * Both callbacks are evaluated inside one attempt, so a failure attributes the one that failed
 * (`parameter_mapping_failed` or `graph_init_failed`) while leaving entry uncommitted. A *committed*
 * entry never repeats: not on Resume, not on a Retry of a later segment, not across a restart.
 */
export function runGraphEntry(
  deps: EngineDeps,
  ctx: SegmentContext,
): Effect.Effect<SegmentOutcome, SegmentFault> {
  const position = positionOf(ctx, 'graph_entry');
  return Effect.gen(function* () {
    const frame = yield* requireFrame(deps, position.frameId);
    const graph = graphOf(ctx.artifact, frame.graphKey);
    if (!graph) {
      // Structure missing under the run's own pin is reported as *this segment* failing rather than
      // as a defect: an adopted Retry can legitimately arrive here, and the person needs a failed
      // attempt they can read and retry rather than a worker that stopped.
      return yield* Effect.fail(
        segmentFailure({
          code: 'graph_init_failed',
          message: `Graph '${frame.graphKey}' is not declared by the pinned artifact.`,
          detail: { graphKey: frame.graphKey, artifactHash: ctx.run.artifactHash },
        }),
      );
    }

    const parameters = yield* resolveParameters(deps, ctx, frame, graph);
    const destination = yield* destinationOf(ctx);

    const initialized = evaluatePure({
      what: `Graph '${frame.graphKey}' init`,
      failureCode: 'graph_init_failed',
      run: () => graph.init(destination, isolate(parameters.value)),
      serializeAs: '',
    });
    if (!initialized.ok) return yield* Effect.fail(segmentFailure(initialized.failure));

    // Checked here rather than at the first update: a field with no reducer is a field nothing can
    // ever change, and naming the graph's `init` is a better diagnostic than naming whichever node
    // later happened to write it.
    const undeclared = assertDeclaredStateFields({
      fields: graph.state,
      state: initialized.value,
      graphKey: frame.graphKey,
    });
    if (undeclared) return yield* Effect.fail(segmentFailure(undeclared));
    const state = initialized.value as Record<string, unknown>;

    const entryNode = nodeOf(graph, graph.entry);
    if (!entryNode) {
      return yield* Effect.fail(
        segmentFailure({
          code: 'graph_init_failed',
          message: `Graph '${frame.graphKey}' declares entry node '${graph.entry}', which the pinned artifact does not contain.`,
          detail: { graphKey: frame.graphKey, nodeId: graph.entry },
        }),
      );
    }

    const frameLabel = captureLabel({
      what: `graph '${frame.graphKey}'`,
      label: graph.label,
      argument: () => parameters.value,
    });
    const nodeLabel = captureLabel({
      what: `node '${graph.entry}'`,
      label: nodeLabelOf(entryNode),
      argument: () => state,
    });

    const committed = yield* deps.runs.commitGraphEntry({
      ...fenceOf(deps, ctx),
      frameId: frame.id,
      // A root frame's parameters were written by run creation and are not rewritten; a child's are
      // produced here, by the child's own entry segment.
      ...(parameters.mapped ? { parameters: { value: parameters.value } } : {}),
      state: { value: state },
      frameDisplayName: frameLabel.displayName,
      entryNode: {
        nodeId: graph.entry,
        nodeKind: nodeKindOf(entryNode),
        displayName: nodeLabel.displayName,
      },
    });
    const outcome = outcomeOfCommit(committed);
    if (outcome.kind === 'advanced') {
      yield* recordLabelDiagnostic(deps, ctx, frame.id, null, frameLabel);
      yield* recordLabelDiagnostic(deps, ctx, frame.id, null, nodeLabel);
    }
    return outcome;
  }).pipe(Effect.catchTag('WorkflowSegmentFailure', recordSegmentFailure(deps, ctx)));
}

/**
 * Where the entering frame's parameters come from.
 *
 * A root frame's are the validated launch inputs, already stored by run creation — they are not
 * recomputed, because nothing can have changed them. A child's are mapped from the parent's
 * committed state by the subgraph node that invoked it, which is why the mapping belongs to the
 * *child's* entry segment and carries its own failure code.
 */
function resolveParameters(
  deps: EngineDeps,
  ctx: SegmentContext,
  frame: WorkflowFrameRecord,
  graph: AnyGraphDefinition,
): Effect.Effect<
  { readonly value: unknown; readonly mapped: boolean },
  SegmentFault | SegmentFailure
> {
  return Effect.gen(function* () {
    if (frame.parentExecutionId === null) {
      const stored = yield* resolveSlot(deps, frame.parameters, 'Launch parameters');
      return { value: stored, mapped: false };
    }

    const parentExecution = yield* deps.runs.findExecution(frame.parentExecutionId);
    if (!parentExecution) {
      return yield* Effect.fail(
        segmentFailure({
          code: 'parameter_mapping_failed',
          message: `The execution that invoked graph '${graph.key}' no longer exists.`,
        }),
      );
    }
    const parentFrame = yield* requireFrame(deps, parentExecution.frameId);
    const parentGraph = graphOf(ctx.artifact, parentFrame.graphKey);
    const node = parentGraph ? nodeOf(parentGraph, parentExecution.nodeId) : null;
    if (!node || node.isagiKind !== 'subgraph-node') {
      return yield* Effect.fail(
        segmentFailure({
          code: 'parameter_mapping_failed',
          message: `Node '${parentExecution.nodeId}' in graph '${parentFrame.graphKey}' no longer registers a subgraph, so there is no parameter mapping to run.`,
          detail: { graphKey: parentFrame.graphKey, nodeId: parentExecution.nodeId },
        }),
      );
    }

    const parentState = yield* frameState(deps, parentFrame);
    const mapped = evaluatePure({
      what: `Parameter mapping for node '${parentExecution.nodeId}'`,
      failureCode: 'parameter_mapping_failed',
      run: () => node.parameters(isolate(parentState)),
      serializeAs: '',
    });
    if (!mapped.ok) return yield* Effect.fail(segmentFailure(mapped.failure));
    return { value: mapped.value, mapped: true };
  });
}

function destinationOf(ctx: SegmentContext): Effect.Effect<WorkflowDestination, SegmentFailure> {
  const { worktreeId, worktreePath, surfaceId } = ctx.run.destination;
  if (worktreeId === null || worktreePath === null || surfaceId === null) {
    return Effect.fail(
      segmentFailure({
        code: 'graph_init_failed',
        message: `Run ${ctx.run.id} has no complete destination, so a graph cannot be initialized against it.`,
      }),
    );
  }
  return Effect.succeed({ worktreeId, worktreePath, surfaceId });
}

export function nodeLabelOf(node: AnyGraphNode): ((state: never) => string) | undefined {
  return node.isagiKind === 'checkpoint-node'
    ? undefined
    : (node.label as ((state: never) => string) | undefined);
}
