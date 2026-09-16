import { Effect } from 'effect';

import type { WorkflowExecutionRecord, WorkflowFrameRecord } from '../../persistence/records.js';
import { isolate } from '../../state/isolation.js';
import { evaluatePure } from '../../state/pure.js';
import { isPlainObject, reduceState } from '../../state/reducers.js';
import type { AnyGraphDefinition } from '../../structure/loader.js';
import type { NodeEvent, SubgraphResult } from '../../types.js';
import { captureLabel } from '../labels.js';
import { destinationKindOf, edgeFromNode, nodeKindOf, nodeOf } from '../structure.js';
import { recordLabelDiagnostic } from './diagnostics.js';
import { nodeLabelOf } from './graph-entry.js';
import {
  fenceOf,
  frameState,
  outcomeOfCommit,
  positionOf,
  ensureRecordable,
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

/** The decision an edge accepted, saved before reduction so a reduction failure can reuse it. */
interface AcceptedDecision {
  readonly to: string;
  readonly update: unknown;
}

/** One shape for the saved decision, so the capture and the commit cannot record different things. */
function decisionOperand(decision: AcceptedDecision): Record<string, unknown> {
  return {
    to: decision.to,
    ...(decision.update === undefined ? {} : { update: decision.update }),
  };
}

/**
 * Routing one node visit's result onward.
 *
 * The router is pure and has no capabilities: it decides over facts the node already produced, so
 * it can never launch an agent, read a file or suspend. The declared-destination check runs
 * *before* anything is reduced or committed, so an undeclared destination rejects the decision
 * outright rather than leaving a reduced state behind for a route nobody declared.
 *
 * The accepted decision is recorded before reduction, which is what makes a later `reduction_failed`
 * resumable without calling `choose` again — including when edited code would now choose
 * differently. Re-choosing would silently change where a run went after it had already decided.
 */
export function runRouting(
  deps: EngineDeps,
  ctx: SegmentContext,
): Effect.Effect<SegmentOutcome, SegmentFault> {
  const position = positionOf(ctx, 'routing');
  return Effect.gen(function* () {
    const frame = yield* requireFrame(deps, position.frameId);
    const execution = yield* requireExecution(deps, position.executionId);
    const graph = yield* requireGraph(ctx, frame, 'edge_choose_failed');
    const state = yield* frameState(deps, frame);

    const edge = edgeFromNode(graph, execution.nodeId);
    if (!edge || edge.id !== position.edgeId) {
      return yield* Effect.fail(
        segmentFailure({
          code: 'edge_choose_failed',
          message: `The edge leaving node '${execution.nodeId}' in graph '${frame.graphKey}' is no longer '${position.edgeId}'.`,
          detail: { graphKey: frame.graphKey, nodeId: execution.nodeId, edgeId: position.edgeId },
        }),
      );
    }

    const consumedWait = yield* deliveredWaitOf(deps, execution.id);
    const saved = yield* deps.runs.findProducerOutput(segmentIdentityOf(ctx.attempt));
    const decision = saved
      ? yield* reuseDecision(deps, saved.slot)
      : yield* chooseDestination(deps, ctx, { frame, execution, graph, state, edgeId: edge.id });
    const producerArtifactHash = saved?.producerArtifactHash ?? ctx.run.artifactHash;

    // Declared even for a reused decision: an adopted pin may no longer declare it, and that is an
    // ordinary new failure under the new code rather than a reason to re-decide.
    if (!edge.edge.to.includes(decision.to)) {
      return yield* Effect.fail(
        segmentFailure({
          code: 'undeclared_destination',
          message: `Edge '${edge.id}' chose '${decision.to}', which it does not declare. Declared destinations: ${edge.edge.to.join(', ')}.`,
          detail: { edgeId: edge.id, chosen: decision.to, declared: [...edge.edge.to] },
        }),
      );
    }

    if (!saved) {
      const unrecordable = ensureRecordable(
        decisionOperand(decision),
        `The decision returned by edge '${edge.id}'`,
      );
      if (unrecordable) return yield* Effect.fail(unrecordable);
      yield* deps.runs.captureProducerOutput({
        ...fenceOf(deps, ctx),
        producerOutput: { value: decisionOperand(decision) },
        producerArtifactHash,
      });
    }

    const reduced = reduceState({
      fields: graph.state,
      current: state,
      update: decision.update,
      graphKey: frame.graphKey,
    });
    if (!reduced.ok) return yield* Effect.fail(segmentFailure(reduced.failure));

    const kind = destinationKindOf(graph, decision.to);
    if (kind === null) {
      return yield* Effect.fail(
        segmentFailure({
          code: 'undeclared_destination',
          message: `Destination '${decision.to}' is declared by edge '${edge.id}' but names neither a node nor an outcome of graph '${frame.graphKey}'.`,
          detail: { edgeId: edge.id, chosen: decision.to, graphKey: frame.graphKey },
        }),
      );
    }

    const nextNode = kind === 'node' ? nodeOf(graph, decision.to) : null;
    const nextLabel = nextNode
      ? captureLabel({
          what: `node '${decision.to}'`,
          label: nodeLabelOf(nextNode),
          argument: () => reduced.state,
        })
      : null;

    const committed = yield* deps.runs.commitRouting({
      ...fenceOf(deps, ctx),
      frameId: frame.id,
      executionId: execution.id,
      state: { value: reduced.state },
      producerOutput: { value: decisionOperand(decision) },
      producerArtifactHash,
      waitId: consumedWait?.id ?? null,
      next:
        nextNode && nextLabel
          ? {
              kind: 'node',
              nodeId: decision.to,
              nodeKind: nodeKindOf(nextNode),
              displayName: nextLabel.displayName,
            }
          : { kind: 'outcome', outcomeId: decision.to },
    });
    const outcome = outcomeOfCommit(committed);
    if (outcome.kind === 'advanced' && nextLabel) {
      yield* recordLabelDiagnostic(deps, ctx, frame.id, null, nextLabel);
    }
    return outcome;
  }).pipe(Effect.catchTag('WorkflowSegmentFailure', recordSegmentFailure(deps, ctx)));
}

function chooseDestination(
  deps: EngineDeps,
  ctx: SegmentContext,
  input: {
    readonly frame: WorkflowFrameRecord;
    readonly execution: WorkflowExecutionRecord;
    readonly graph: AnyGraphDefinition;
    readonly state: Record<string, unknown>;
    readonly edgeId: string;
  },
): Effect.Effect<AcceptedDecision, SegmentFault | SegmentFailure> {
  return Effect.gen(function* () {
    const event = yield* resolveEvent(deps, input.execution);
    const edge = edgeFromNode(input.graph, input.execution.nodeId)!;
    const chosen = evaluatePure({
      what: `Edge '${input.edgeId}'`,
      failureCode: 'edge_choose_failed',
      run: () => edge.edge.choose(isolate(input.state) as never, isolate(event) as NodeEvent),
    });
    if (!chosen.ok) return yield* Effect.fail(segmentFailure(chosen.failure));
    const decision = chosen.value as { readonly to?: unknown; readonly update?: unknown } | null;
    if (!isPlainObject(decision) || typeof decision.to !== 'string') {
      return yield* Effect.fail(
        segmentFailure({
          code: 'edge_choose_failed',
          message: `Edge '${input.edgeId}' must return a destination; received ${JSON.stringify(chosen.value) ?? 'undefined'}.`,
        }),
      );
    }
    return { to: decision.to, update: decision.update };
  });
}

/**
 * What the router sees, built from how this execution actually arrived at `routing`.
 *
 * A completed child's result is read from the child frame's own immutable columns rather than from
 * a copy saved on the parent. There is one authoritative record of what a child produced, and
 * duplicating it would create two versions of one fact that a parent Retry under new code could
 * then disagree about.
 */
function resolveEvent(
  deps: EngineDeps,
  execution: WorkflowExecutionRecord,
): Effect.Effect<NodeEvent, SegmentFault | SegmentFailure> {
  return Effect.gen(function* () {
    if (execution.childFrameId !== null) {
      const child = yield* requireFrame(deps, execution.childFrameId);
      if (child.status !== 'completed' || child.outcomeId === null || child.outcomeKind === null) {
        return yield* Effect.fail(
          segmentFailure({
            code: 'edge_choose_failed',
            message: `The child frame invoked by node '${execution.nodeId}' has not published an outcome, so there is no result to route on.`,
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
      return { kind: 'subgraph', result } satisfies NodeEvent;
    }

    const wait = yield* deliveredWaitOf(deps, execution.id);
    if (!wait) return { kind: 'immediate' } satisfies NodeEvent;
    const event = yield* resolveSlot(deps, wait.event, `Event delivered to wait ${wait.id}`);
    if (!isPlainObject(event) || typeof event.kind !== 'string') {
      return yield* Effect.fail(
        segmentFailure({
          code: 'edge_choose_failed',
          message: `Wait ${wait.id} carries no readable event, so this router has nothing to decide on.`,
          detail: { waitId: wait.id },
        }),
      );
    }
    return event as unknown as NodeEvent;
  });
}

/** The wait this visit is routing out of, if it suspended at all. */
function deliveredWaitOf(deps: EngineDeps, executionId: number) {
  return deps.runs
    .listWaitsForExecution(executionId)
    .pipe(
      Effect.map((waits) => waits.filter((wait) => wait.status === 'delivered').at(-1) ?? null),
    );
}

function reuseDecision(
  deps: EngineDeps,
  slot: NonNullable<Parameters<typeof resolveSlot>[1]>,
): Effect.Effect<AcceptedDecision, SegmentFailure> {
  return resolveSlot(deps, slot, 'Saved routing decision').pipe(
    Effect.flatMap((value) =>
      isPlainObject(value) && typeof value.to === 'string'
        ? Effect.succeed<AcceptedDecision>({ to: value.to, update: value.update })
        : Effect.fail(
            segmentFailure({
              code: 'payload_unavailable',
              message:
                'The saved routing decision for this segment is not a recognizable decision.',
            }),
          ),
    ),
  );
}
