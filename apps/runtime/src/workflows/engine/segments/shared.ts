import { Effect } from 'effect';

import type { WorkflowRunPosition, WorkflowSegmentKind } from '@isagi/contracts';

import type { DatabaseError } from '../../../persistence/index.js';
import type { WorkflowOperationServiceShape } from '../../operations/operation.service.js';
import type { WorkflowOperationsRepositoryService } from '../../persistence/operations.repository.js';
import type { SegmentCommitOutcome, WorkflowWriteResult } from '../../persistence/outcomes.js';
import type { PayloadPublishError, PayloadSlot } from '../../persistence/payload-store.js';
import type { WorkflowPayloadStoreService } from '../../persistence/payload-store.js';
import type {
  WorkflowAttemptRecord,
  WorkflowExecutionRecord,
  WorkflowFrameRecord,
  WorkflowRunRecord,
} from '../../persistence/records.js';
import type {
  SegmentIdentity,
  WorkflowRunsRepositoryService,
} from '../../persistence/runs.repository.js';
import { checkSerializable, type PureFailure } from '../../state/pure.js';
import type { LoadedWorkflowArtifact } from '../../structure/loader.js';

/**
 * What every segment handler shares.
 *
 * The handlers are deliberately thin: they resolve structure from the pin, evaluate the author's
 * pure code, and hand the result to one named transaction. Nothing here opens a transaction or
 * touches a table — the repository owns every durable write, and that boundary is what makes "one
 * commit per segment" checkable by reading a handler top to bottom.
 */
export interface EngineDeps {
  readonly runs: WorkflowRunsRepositoryService;
  readonly payloads: WorkflowPayloadStoreService;
  readonly operations: WorkflowOperationServiceShape;
  /**
   * Read composition over the operation records, for the questions the interpreter owns.
   *
   * Only reads: every durable operation write belongs to the operation service, and the interpreter
   * asking "does this wait name operations of this visit?" must not become a second writer.
   */
  readonly operationRecords: Pick<
    WorkflowOperationsRepositoryService,
    'listForExecution' | 'findByKey'
  >;
  /**
   * Re-checks one wait the moment it is armed.
   *
   * The window this closes is small and entirely real: an operation can settle between the callback
   * returning and the suspend committing, and the notification it published then found no wait to
   * satisfy. Without this the run would sit `waiting` until some unrelated event happened to wake
   * the resolver.
   *
   * Total by construction. The suspend is already durable when this runs, so a reconciliation that
   * cannot complete must not be allowed to fail the segment or re-enter the callback — the armed
   * wait stays authoritative and event, Resume and startup reconciliation all retry it.
   */
  readonly reconcileWait: (waitId: number) => Effect.Effect<boolean>;
  /** Identifies this worker, which is half of the attempt-ownership fence. */
  readonly owner: string;
  readonly ownerIncarnation: string;
}

/**
 * One claimed segment, executing against the snapshot it was claimed with.
 *
 * `run` is the record the claim returned, not a fresh read. That matters: the operation context's
 * call positions are keyed to this execution, so re-reading different operands at callback time
 * would produce a prefix that does not describe the recorded work.
 */
export interface SegmentContext {
  readonly run: WorkflowRunRecord;
  readonly attempt: WorkflowAttemptRecord;
  readonly artifact: LoadedWorkflowArtifact;
}

/** Infrastructure failures. Author and structural failures are recorded as failed attempts instead. */
export type SegmentFault = DatabaseError | PayloadPublishError;

/**
 * An author or structural failure, travelling in the error channel until the handler records it.
 *
 * Tagged so it can be separated from a genuine infrastructure fault by `catchTag`. The distinction
 * is the whole point: a `SegmentFailure` becomes a retained failed attempt the person can look at
 * and retry, while a `SegmentFault` means the database or the payload store is broken and the
 * dispatcher should stop rather than spin.
 */
export interface SegmentFailure {
  readonly _tag: 'WorkflowSegmentFailure';
  readonly failure: PureFailure;
}

export function segmentFailure(failure: PureFailure): SegmentFailure {
  return { _tag: 'WorkflowSegmentFailure', failure };
}

/**
 * What the fencing helpers below actually read.
 *
 * Narrowed to a `Pick` rather than typed as `EngineDeps` so the preparation segment can reuse them
 * without pretending to own a payload store, an operation service or a wait reconciler — none of
 * which it has, and none of which fencing a failed attempt has ever needed.
 */
export type FencedDeps = Pick<EngineDeps, 'runs' | 'owner' | 'ownerIncarnation'>;

/** The same narrowing on the context side: preparation runs before any artifact is pinned to it. */
export type FencedContext = Pick<SegmentContext, 'run' | 'attempt'>;

/** Records the failure the handler raised, which is always an ordinary outcome. */
export function recordSegmentFailure(deps: FencedDeps, ctx: FencedContext) {
  return (raised: SegmentFailure) => failSegment(deps, ctx, raised.failure);
}

/** What the dispatcher learns from running one segment. */
export type SegmentOutcome =
  | { readonly kind: 'advanced' }
  /** The segment ran and recorded a failure, or the run was cancelled under it. Not a fault. */
  | { readonly kind: 'halted'; readonly reason: string };

export const advanced: SegmentOutcome = { kind: 'advanced' };

export function halted(reason: string): SegmentOutcome {
  return { kind: 'halted', reason };
}

export function fenceOf(deps: FencedDeps, ctx: FencedContext) {
  return {
    runId: ctx.run.id,
    attemptId: ctx.attempt.id,
    owner: deps.owner,
    ownerIncarnation: deps.ownerIncarnation,
  };
}

/** The segment identity a producer operand is keyed by, derived from the claimed attempt. */
export function segmentIdentityOf(attempt: WorkflowAttemptRecord): SegmentIdentity {
  return {
    frameId: attempt.frameId,
    executionId: attempt.executionId,
    segmentKind: attempt.segmentKind,
    segmentRef: attempt.segmentRef,
  };
}

/**
 * Records an author or structural failure against the claimed attempt.
 *
 * Always an ordinary outcome, never a fault: a callback that threw is exactly the case the run is
 * supposed to survive, with the attempt, its inputs and its saved operand all retained for the
 * person to look at and retry.
 */
export function failSegment(
  deps: FencedDeps,
  ctx: FencedContext,
  failure: PureFailure,
): Effect.Effect<SegmentOutcome, SegmentFault> {
  return deps.runs
    .failSegment({
      ...fenceOf(deps, ctx),
      code: failure.code,
      message: failure.message,
      ...(failure.detail === undefined ? {} : { detail: { value: failure.detail } }),
    })
    .pipe(Effect.map(() => halted(failure.code)));
}

/**
 * Turns a guarded commit's result into a segment outcome.
 *
 * A rejection is expected, not exceptional: a claim that lost a race, a Pause that landed first, a
 * run cancelled under a running callback. Each means "this worker is no longer the one advancing
 * the run", and the honest response is to stop rather than to retry blindly.
 */
export function outcomeOfCommit(result: WorkflowWriteResult<SegmentCommitOutcome>): SegmentOutcome {
  if (!result.ok) return halted(`rejected:${result.rejection.kind}`);
  return result.value === 'advanced' ? advanced : halted('cancelled_evidence');
}

/**
 * Reads a stored slot, mapping an unreadable payload to a segment failure.
 *
 * `payload_unavailable` exists so a corrupted or missing payload parks the run visibly instead of
 * the interpreter substituting empty state and carrying on — which would silently discard whatever
 * the author's state actually held.
 */
export function resolveSlot(
  deps: EngineDeps,
  slot: PayloadSlot | null,
  what: string,
): Effect.Effect<unknown, SegmentFailure> {
  if (slot === null) return Effect.succeed(undefined);
  return deps.payloads.resolve(slot).pipe(
    Effect.mapError((cause) =>
      segmentFailure({
        code: 'payload_unavailable',
        message: `${what} could not be read (${cause.cause} reference ${cause.ref}).`,
        detail: { what, ref: cause.ref, cause: cause.cause },
      }),
    ),
  );
}

/**
 * Checks a producer operand before it is published.
 *
 * The operand is written *before* reduction, so it reaches the payload boundary first — and a value
 * the boundary refuses would otherwise surface as an infrastructure fault out of the claim, leaving
 * the run `running` with an open attempt instead of a failed segment somebody can read and retry.
 * Reduction's own serializability check runs too late to catch it, and never sees a suspend's wait
 * declaration at all.
 */
export function ensureRecordable(value: unknown, what: string): SegmentFailure | null {
  const unserializable = checkSerializable(value, '');
  return unserializable === null
    ? null
    : segmentFailure({
        code: 'unserializable_state',
        message: `${what} ${unserializable.message}`,
        detail: { path: unserializable.path },
      });
}

/** A frame's committed state boundary, as a plain object the reducers can work from. */
export function frameState(
  deps: EngineDeps,
  frame: WorkflowFrameRecord,
): Effect.Effect<Record<string, unknown>, SegmentFailure> {
  return resolveSlot(deps, frame.state, `State of frame ${frame.id}`).pipe(
    Effect.map((value) => (value === undefined ? {} : (value as Record<string, unknown>))),
  );
}

export function requireFrame(
  deps: EngineDeps,
  frameId: number,
): Effect.Effect<WorkflowFrameRecord, SegmentFault | SegmentFailure> {
  return deps.runs.findFrame(frameId).pipe(
    Effect.flatMap((frame) =>
      frame
        ? Effect.succeed(frame)
        : Effect.fail(
            segmentFailure({
              code: 'payload_unavailable',
              message: `Frame ${frameId} named by the saved position no longer exists.`,
            }),
          ),
    ),
  );
}

/**
 * The position a claimed attempt belongs to, reconstructed for a commit that needs it.
 *
 * Handlers take the position from the run record they claimed with rather than re-reading it, so
 * this is a narrowing helper rather than a lookup.
 */
export function positionOf<K extends WorkflowRunPosition['kind']>(
  ctx: SegmentContext,
  kind: K,
): Extract<WorkflowRunPosition, { kind: K }> {
  const position = ctx.run.position;
  if (position.kind !== kind) {
    throw new Error(
      `Segment handler for '${kind}' was given a run parked at '${position.kind}'. The dispatcher must switch on the saved position.`,
    );
  }
  return position as Extract<WorkflowRunPosition, { kind: K }>;
}

export function segmentKindOfPosition(
  kind: WorkflowRunPosition['kind'],
): WorkflowSegmentKind | null {
  switch (kind) {
    case 'environment_preparation':
      return 'environment_preparation';
    case 'graph_entry':
      return 'graph_entry';
    case 'node_callback':
      return 'node_callback';
    case 'routing':
      return 'routing';
    case 'graph_output':
      return 'graph_output';
    case 'child_output_mapping':
      return 'output_mapping';
    default:
      return null;
  }
}

export function requireExecution(
  deps: EngineDeps,
  executionId: number,
): Effect.Effect<WorkflowExecutionRecord, SegmentFault | SegmentFailure> {
  return deps.runs.findExecution(executionId).pipe(
    Effect.flatMap((execution) =>
      execution
        ? Effect.succeed(execution)
        : Effect.fail(
            segmentFailure({
              code: 'payload_unavailable',
              message: `Execution ${executionId} named by the saved position no longer exists.`,
            }),
          ),
    ),
  );
}

/**
 * The graph a frame is executing, resolved from the run's own pin.
 *
 * The failure code is the caller's, because "the code this segment needs is not in the pinned
 * artifact" reads differently at each segment: an entry that cannot initialize, a router with no
 * edge, an output with no outcome. Reporting it as *this segment* failing — rather than as a defect
 * — is what lets an adopted Retry that removed a graph produce a failed attempt the person can read.
 */
export function requireGraph(
  ctx: SegmentContext,
  frame: WorkflowFrameRecord,
  failureCode: PureFailure['code'],
): Effect.Effect<import('../../structure/loader.js').AnyGraphDefinition, SegmentFailure> {
  const graph = ctx.artifact.graphs.get(frame.graphKey);
  return graph
    ? Effect.succeed(graph)
    : Effect.fail(
        segmentFailure({
          code: failureCode,
          message: `Graph '${frame.graphKey}' is not declared by the pinned artifact.`,
          detail: { graphKey: frame.graphKey, artifactHash: ctx.run.artifactHash },
        }),
      );
}
