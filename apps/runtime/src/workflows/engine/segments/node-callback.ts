import { Effect } from 'effect';

import type { WorkflowWaitKind } from '@isagi/contracts';

import { OperationRejection } from '../../operations/errors.js';
import type { WorkflowExecutionRecord, WorkflowFrameRecord } from '../../persistence/records.js';
import { isolate } from '../../state/isolation.js';
import { errorMessage, pureFailure, type PureFailure, type PureResult } from '../../state/pure.js';
import { reduceState } from '../../state/reducers.js';
import type { AnyGraphDefinition } from '../../structure/loader.js';
import type { OperationContext, WaitDeclaration } from '../../types.js';
import { attemptTurnRecovery } from '../../waits/turn-recovery.js';
import { headlessHandlesOf, validateOperationResult, type ValidatedResult } from '../results.js';
import { edgeFromNode, nodeOf } from '../structure.js';
import {
  fenceOf,
  frameState,
  outcomeOfCommit,
  positionOf,
  ensureRecordable,
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
 * Running one node visit's callback, or resuming the reduction of a result it already produced.
 *
 * The recovery decision is made from a **durable operand**, not from the last failure code: if any
 * prior attempt for this segment saved a producer result, this attempt reuses it and resumes at
 * reduction. That is what makes a reduction failure survivable without re-entering a callback whose
 * operations already crossed external boundaries, and it holds across an unbounded number of
 * retries, across restarts and across edited-code adoption — the only thing that ends a segment is a
 * successful commit.
 */
export function runNodeCallback(
  deps: EngineDeps,
  ctx: SegmentContext,
  execution: WorkflowExecutionRecord,
): Effect.Effect<SegmentOutcome, SegmentFault> {
  const position = positionOf(ctx, 'node_callback');
  return Effect.gen(function* () {
    const frame = yield* requireFrame(deps, position.frameId);
    const graph = yield* requireGraph(ctx, frame, 'node_callback_failed');
    const node = nodeOf(graph, execution.nodeId);

    if (!node) {
      return yield* Effect.fail(
        segmentFailure({
          code: 'node_callback_failed',
          message: `Node '${execution.nodeId}' is not declared by graph '${frame.graphKey}' in the pinned artifact.`,
          detail: { graphKey: frame.graphKey, nodeId: execution.nodeId },
        }),
      );
    }
    if (node.isagiKind !== 'operation-node') {
      // A subgraph node never reaches a claimed segment — the dispatcher enters it structurally,
      // with no attempt — and a checkpoint execution is dispatched to `runCheckpoint`. Either one
      // arriving here means the execution row and the pinned graph disagree, so it fails the
      // segment rather than running as an operation alias or claiming a successful checkpoint.
      return yield* Effect.fail(
        segmentFailure({
          code: 'unsupported_node_kind',
          message: `Node '${execution.nodeId}' is a ${node.isagiKind.replace('-node', '')} node and cannot be executed as an operation callback.`,
          detail: { nodeId: execution.nodeId, kind: node.isagiKind },
        }),
      );
    }

    // The single committed boundary this segment runs against. Read once: the callback, the
    // reduction and the recorded attempt input must all describe the same snapshot.
    const state = yield* frameState(deps, frame);

    const saved = yield* deps.runs.findProducerOutput(segmentIdentityOf(ctx.attempt));
    const result = saved
      ? yield* reuseSavedResult(deps, saved.slot)
      : yield* invokeCallback(deps, ctx, { frame, execution, state, node });

    // A reused operand keeps the pin that produced it. The retrying attempt's own pin is recorded on
    // the attempt row, so both facts stay visible without either being invented.
    const producerArtifactHash = saved?.producerArtifactHash ?? ctx.run.artifactHash;
    if (!saved) {
      // Checked here rather than left to the payload boundary: the whole result is about to be
      // recorded, wait declaration included, and a value that cannot be stored is an author error
      // this segment reports — not a persistence fault that strands the claim.
      const unrecordable = ensureRecordable(
        serializableResult(result),
        `The result returned by node '${execution.nodeId}'`,
      );
      if (unrecordable) return yield* Effect.fail(unrecordable);
      yield* deps.runs.captureProducerOutput({
        ...fenceOf(deps, ctx),
        producerOutput: { value: serializableResult(result) },
        producerArtifactHash,
      });
    }

    const reduced = reduceState({
      fields: graph.state,
      current: state,
      update: result.update,
      graphKey: frame.graphKey,
    });
    if (!reduced.ok) return yield* Effect.fail(segmentFailure(reduced.failure));

    const next = yield* nextPositionOf(graph, execution, result);
    const committed = yield* deps.runs.commitNodeResult({
      ...fenceOf(deps, ctx),
      frameId: frame.id,
      executionId: execution.id,
      state: { value: reduced.state },
      producerOutput: { value: serializableResult(result) },
      producerArtifactHash,
      next,
    });
    const outcome = outcomeOfCommit(committed);
    if (outcome.kind === 'advanced' && next.kind === 'suspend') {
      yield* reconcileArmedWait(deps, ctx.run.id);
    }
    return outcome;
  }).pipe(Effect.catchTag('WorkflowSegmentFailure', recordSegmentFailure(deps, ctx)));
}

/**
 * Re-checks the wait this segment just armed, against durable evidence.
 *
 * The wait id is read back from the saved position rather than returned by the commit, because the
 * position *is* where a suspended run parks — and if the resolver has already delivered it by the
 * time this runs, the position has moved and there is correctly nothing to do.
 *
 * Every failure path here is swallowed on purpose. The suspend committed; reporting this segment as
 * failed afterwards would contradict a durable fact and re-enter a callback whose effects already
 * crossed a boundary. A reconciliation that cannot run leaves the armed wait authoritative, and the
 * subscriber, Resume and startup recovery all reach it again.
 */
function reconcileArmedWait(deps: EngineDeps, runId: number): Effect.Effect<void> {
  return deps.runs.findRun(runId).pipe(
    Effect.flatMap((current) =>
      current?.position.kind === 'awaiting_wait'
        ? deps.reconcileWait(current.position.waitId)
        : Effect.succeed(false),
    ),
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        console.warn('[runtime] Arm-time wait reconciliation failed; the wait stays armed', {
          runId,
          cause,
        });
        return false;
      }),
    ),
    Effect.asVoid,
  );
}

/**
 * Entering the author's callback, with a live operation context scoped to this attempt.
 *
 * Two checks bracket it and both are about honesty of the recorded work. Before: the operations
 * this execution already recorded have been reconciled by the dispatcher, so a re-entered callback
 * meets settled receipts rather than uncertainty. After: the callback must have consumed the whole
 * recorded prefix — an omitted call means the code no longer matches the effects on record, and
 * accepting it would silently orphan an effect that really happened.
 */
function invokeCallback(
  deps: EngineDeps,
  ctx: SegmentContext,
  input: {
    readonly frame: WorkflowFrameRecord;
    readonly execution: WorkflowExecutionRecord;
    readonly state: Record<string, unknown>;
    readonly node: Extract<ReturnType<typeof nodeOf>, { isagiKind: 'operation-node' }>;
  },
): Effect.Effect<ValidatedResult, SegmentFault | SegmentFailure> {
  return Effect.gen(function* () {
    const destination = ctx.run.destination;
    if (
      destination.worktreeId === null ||
      destination.worktreePath === null ||
      destination.surfaceId === null
    ) {
      return yield* Effect.fail(
        segmentFailure({
          code: 'node_callback_failed',
          message: `Run ${ctx.run.id} has no complete destination, so an operation callback cannot be placed.`,
        }),
      );
    }

    const outcome = yield* deps.operations
      .withAttemptContext(
        {
          runId: ctx.run.id,
          frameId: input.frame.id,
          executionId: input.execution.id,
          attemptId: ctx.attempt.id,
          attemptIndex: ctx.attempt.attemptIndex,
          invocationKind: ctx.attempt.invocationKind,
          artifactHash: ctx.run.artifactHash,
          agentTurnRecovery: ctx.attempt.input
            ? attemptTurnRecovery(
                yield* resolveSlot(deps, ctx.attempt.input, `Input of attempt ${ctx.attempt.id}`),
              )
            : null,
          destination: {
            worktreeId: destination.worktreeId,
            worktreePath: destination.worktreePath,
            surfaceId: destination.surfaceId,
          },
        },
        (operationContext: OperationContext) =>
          Effect.tryPromise({
            try: async () => input.node.run(operationContext, isolate(input.state) as never),
            catch: (cause) => cause,
          }),
      )
      .pipe(Effect.mapError((cause) => segmentFailure(callbackRejection(cause))));

    if (outcome.consumedCallCount < outcome.recordedCallCount) {
      return yield* Effect.fail(
        segmentFailure({
          code: 'operation_prefix_unconsumed',
          message: `This callback made ${outcome.consumedCallCount} recorded operation calls, but ${outcome.recordedCallCount} are already on record for this visit. A re-entered callback must reach every recorded call position.`,
          detail: {
            consumed: outcome.consumedCallCount,
            recorded: outcome.recordedCallCount,
          },
        }),
      );
    }

    const validated = validateOperationResult(outcome.value);
    if (!validated.ok) return yield* Effect.fail(segmentFailure(validated.failure));
    const wait = validated.value.type === 'suspend' ? validated.value.wait : null;
    if (wait) {
      const owned = yield* waitBelongsToExecution(deps, input.execution.id, wait);
      if (!owned.ok) return yield* Effect.fail(segmentFailure(owned.failure));
    }
    return validated.value;
  });
}

/**
 * A rejected `ctx` call is an execution-segment failure, never a fabricated agent outcome.
 *
 * The codes the capability layer raises are mapped through where the contract has a matching segment
 * failure code, so the inspector can say "this callback tried to insert a call at a recorded
 * position" rather than "something threw".
 */
function callbackRejection(cause: unknown): PureFailure {
  if (cause instanceof OperationRejection) {
    switch (cause.code) {
      case 'operation_request_changed':
      case 'operation_prefix_unresolved':
      case 'operation_uncertain':
      case 'operation_context_closed':
      // Passed through rather than folded into `node_callback_failed` so `detail.reason` survives
      // to the inspector and to author code catching the rejection: which rule a capture broke is
      // the whole diagnostic, and a generic callback failure would erase it.
      case 'evidence_capture_rejected':
        return { code: cause.code, message: cause.message, detail: { ...cause.detail } };
      default:
        return {
          code: 'node_callback_failed',
          message: cause.message,
          detail: { rejection: cause.code, ...cause.detail },
        };
    }
  }
  return {
    code: 'node_callback_failed',
    message: `The node callback threw: ${errorMessage(cause)}.`,
  };
}

/**
 * Every headless handle a wait declares must name an operation of *this* execution.
 *
 * Without it a callback could suspend on another visit's operation and consume its result, which
 * would make a settled effect satisfy a wait nobody armed for it.
 */
function waitBelongsToExecution(
  deps: EngineDeps,
  executionId: number,
  wait: WaitDeclaration,
): Effect.Effect<PureResult<true>, SegmentFault> {
  const declared = headlessHandlesOf(wait);
  if (declared.length === 0) return Effect.succeed({ ok: true, value: true });
  return deps.operationRecords.listForExecution(executionId).pipe(
    Effect.map((records) => {
      const owned = new Set(records.map((record) => record.operationKey));
      const foreign = declared.filter((handle) => !owned.has(handle));
      if (foreign.length > 0) {
        return pureFailure(
          'node_callback_failed',
          `This wait names operations that do not belong to this node visit: ${foreign.join(', ')}.`,
          { operations: foreign },
        );
      }
      return { ok: true, value: true } as PureResult<true>;
    }),
  );
}

/** Where the run parks next: its router, or the wait the result declared. */
function nextPositionOf(
  graph: AnyGraphDefinition,
  execution: WorkflowExecutionRecord,
  result: ValidatedResult,
): Effect.Effect<
  | { readonly kind: 'routing'; readonly edgeId: string }
  | {
      readonly kind: 'suspend';
      readonly waitKind: WorkflowWaitKind;
      readonly condition: { readonly value: unknown };
    },
  SegmentFailure
> {
  if (result.type === 'suspend') {
    return Effect.succeed({
      kind: 'suspend',
      waitKind: result.wait.kind,
      condition: { value: result.wait },
    });
  }
  // An immediate completion still routes as its own segment, on an `immediate` event. No artificial
  // external wait is invented to get there.
  const edge = edgeFromNode(graph, execution.nodeId);
  if (!edge) {
    return Effect.fail(
      segmentFailure({
        code: 'node_callback_failed',
        message: `Graph '${graph.key}' no longer declares exactly one edge leaving node '${execution.nodeId}', so this result has nowhere to route.`,
        detail: { graphKey: graph.key, nodeId: execution.nodeId },
      }),
    );
  }
  return Effect.succeed({ kind: 'routing', edgeId: edge.id });
}

/** The saved operand, read back into the same shape a fresh callback would have produced. */
function reuseSavedResult(
  deps: EngineDeps,
  slot: NonNullable<Parameters<typeof resolveSlot>[1]>,
): Effect.Effect<ValidatedResult, SegmentFailure> {
  return resolveSlot(deps, slot, 'Saved callback result').pipe(
    Effect.flatMap((value) => {
      const stored = value as {
        readonly type?: unknown;
        readonly update?: unknown;
        readonly wait?: unknown;
      };
      if (stored?.type === 'complete') {
        return Effect.succeed<ValidatedResult>({ type: 'complete', update: stored.update });
      }
      if (stored?.type === 'suspend' && stored.wait) {
        return Effect.succeed<ValidatedResult>({
          type: 'suspend',
          update: stored.update,
          wait: stored.wait as WaitDeclaration,
        });
      }
      return Effect.fail(
        segmentFailure({
          code: 'payload_unavailable',
          message:
            'The saved callback result for this segment is not a recognizable operation result.',
        }),
      );
    }),
  );
}

/** The producer operand as stored: the discriminant, the update and the wait, and nothing else. */
function serializableResult(result: ValidatedResult): Record<string, unknown> {
  return result.type === 'complete'
    ? { type: 'complete', ...(result.update === undefined ? {} : { update: result.update }) }
    : {
        type: 'suspend',
        ...(result.update === undefined ? {} : { update: result.update }),
        wait: result.wait,
      };
}
