import { Effect } from 'effect';

import type { WorkflowOutcomeKind } from '@isagi/contracts';

import { isolate } from '../../state/isolation.js';
import { evaluatePure } from '../../state/pure.js';
import { isPlainObject } from '../../state/reducers.js';
import { outcomeOf } from '../structure.js';
import {
  fenceOf,
  frameState,
  outcomeOfCommit,
  positionOf,
  recordSegmentFailure,
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
 * The completion fact a frame publishes: which outcome, why, and what it produced.
 *
 * Saved whole as the segment's producer operand rather than as a bare output value, so that a later
 * attempt publishing a reused output publishes the *producing* pin's account of it. Taking the
 * outcome's kind and reason from whichever pin happened to commit would attribute one version's
 * metadata to another version's value.
 */
interface EvaluatedOutcome {
  readonly outcomeId: string;
  readonly outcomeKind: WorkflowOutcomeKind;
  readonly reason: string | null;
  readonly output: unknown;
}

/**
 * Evaluating a frame's chosen outcome, and publishing it.
 *
 * The evaluation runs under the **run's current pin**, like every other uncommitted segment. Using
 * the frame's entry pin would mean an output evaluator that throws could only ever be retried as the
 * same broken code, because Retry adopts a new pin at the run level and a frame's entry pin never
 * moves.
 *
 * Publication branches on depth and *only* on depth: a root completes the run, a child completes its
 * frame and hands the parent its mapping. Once committed, the stored outcome, reason, output and
 * producing version are immutable — which is what stops an edited parent's Retry from recomputing a
 * completed child's output under new child code.
 */
export function runGraphOutput(
  deps: EngineDeps,
  ctx: SegmentContext,
): Effect.Effect<SegmentOutcome, SegmentFault> {
  const position = positionOf(ctx, 'graph_output');
  return Effect.gen(function* () {
    const frame = yield* requireFrame(deps, position.frameId);
    const graph = yield* requireGraph(ctx, frame, 'output_evaluation_failed');

    const saved = yield* deps.runs.findProducerOutput(segmentIdentityOf(ctx.attempt));
    const evaluated = saved
      ? yield* reuseOutcome(deps, saved.slot)
      : yield* evaluateOutcome(deps, frame.id, graph, position.outcomeId);
    // The pin that actually produced the value, carried forward unchanged by a retrying attempt.
    const producerArtifactHash = saved?.producerArtifactHash ?? ctx.run.artifactHash;

    if (!saved) {
      yield* deps.runs.captureProducerOutput({
        ...fenceOf(deps, ctx),
        producerOutput: { value: { ...evaluated } },
        producerArtifactHash,
      });
    }

    const publication = {
      ...fenceOf(deps, ctx),
      frameId: frame.id,
      outcomeId: evaluated.outcomeId,
      outcomeKind: evaluated.outcomeKind,
      outcomeReason: evaluated.reason,
      output: { value: evaluated.output },
      outputArtifactHash: producerArtifactHash,
    };
    const committed =
      frame.parentExecutionId === null
        ? yield* deps.runs.completeRun(publication)
        : yield* deps.runs.publishChildOutput(publication);
    return outcomeOfCommit(committed);
  }).pipe(Effect.catchTag('WorkflowSegmentFailure', recordSegmentFailure(deps, ctx)));
}

function evaluateOutcome(
  deps: EngineDeps,
  frameId: number,
  graph: import('../../structure/loader.js').AnyGraphDefinition,
  outcomeId: string,
): Effect.Effect<EvaluatedOutcome, SegmentFault | SegmentFailure> {
  return Effect.gen(function* () {
    const outcome = outcomeOf(graph, outcomeId);
    if (!outcome) {
      return yield* Effect.fail(
        segmentFailure({
          code: 'output_evaluation_failed',
          message: `Outcome '${outcomeId}' is no longer declared by graph '${graph.key}'.`,
          detail: { graphKey: graph.key, outcomeId },
        }),
      );
    }
    const frame = yield* requireFrame(deps, frameId);
    const state = yield* frameState(deps, frame);
    const produced = evaluatePure({
      what: `Outcome '${outcomeId}' output`,
      failureCode: 'output_evaluation_failed',
      run: () => outcome.output(isolate(state) as never),
      serializeAs: '',
    });
    if (!produced.ok) return yield* Effect.fail(segmentFailure(produced.failure));
    return {
      outcomeId,
      outcomeKind: outcome.kind,
      reason: outcome.reason ?? null,
      output: produced.value,
    };
  });
}

function reuseOutcome(
  deps: EngineDeps,
  slot: NonNullable<Parameters<typeof resolveSlot>[1]>,
): Effect.Effect<EvaluatedOutcome, SegmentFailure> {
  return resolveSlot(deps, slot, 'Saved graph output').pipe(
    Effect.flatMap((value) =>
      isPlainObject(value) &&
      typeof value.outcomeId === 'string' &&
      (value.outcomeKind === 'success' || value.outcomeKind === 'failure')
        ? Effect.succeed<EvaluatedOutcome>({
            outcomeId: value.outcomeId,
            outcomeKind: value.outcomeKind,
            reason: typeof value.reason === 'string' ? value.reason : null,
            output: value.output,
          })
        : Effect.fail(
            segmentFailure({
              code: 'payload_unavailable',
              message:
                'The saved graph output for this segment is not a recognizable completion fact.',
            }),
          ),
    ),
  );
}
