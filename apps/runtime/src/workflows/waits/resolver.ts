import { Effect } from 'effect';

import type { DatabaseError } from '../../persistence/index.js';
import type { InternalRuntimeEventBusService } from '../../runtime-events/internal-event-bus.js';
import { validateWaitDeclaration } from '../engine/results.js';
import { edgeFromNode } from '../engine/structure.js';
import type { WorkflowOperationServiceShape } from '../operations/operation.service.js';
import type { WorkflowOperationsRepositoryService } from '../persistence/operations.repository.js';
import type {
  PayloadPublishError,
  WorkflowPayloadStoreService,
} from '../persistence/payload-store.js';
import type { WorkflowOperationRecord, WorkflowWaitRecord } from '../persistence/records.js';
import type { WorkflowRunsRepositoryService } from '../persistence/runs.repository.js';
import type { WorkflowArtifactCatalogService } from '../structure/artifact-catalog.js';
import type { HeadlessOperationResult, NodeEvent, WaitDeclaration } from '../types.js';
import {
  selectTurnAssociation,
  terminalForFixedAssociation,
  type WorkflowObservedTurnEdge,
} from './conditions.js';
import { recoveryWaitDeclaration, terminalForRecovery, turnEventOf } from './turn-recovery.js';

/**
 * The only writer of wait delivery.
 *
 * Delivery is targeted at a **wait id**, never at a run: a stale form or a late external result
 * cannot satisfy a different visit's wait, and a duplicate delivery is refused by the wait row's own
 * monotonic guard rather than by coordination between callers.
 *
 * Delivery always records the event. Whether the run *advances* is a separate question, answered by
 * whether the run is still non-terminal — a cancelled, done or failed run keeps its status and
 * position and retains the event as late evidence. Pause is not consulted at all: a paused run's
 * wait resolves durably and becomes ready, and the gate stops the next dispatch rather than the
 * fact.
 */
export interface WaitResolver {
  /** Re-evaluate every armed wait, or those of one run. Returns how many were delivered. */
  readonly reconcileWaits: (runId?: number) => Effect.Effect<number>;
  /** Re-evaluate one wait, which is what arm-time reconciliation calls after a suspend commits. */
  readonly reconcileWait: (waitId: number) => Effect.Effect<boolean>;
}

export interface WaitResolverDeps {
  readonly runs: WorkflowRunsRepositoryService;
  readonly payloads: WorkflowPayloadStoreService;
  readonly operationRecords: Pick<
    WorkflowOperationsRepositoryService,
    'listForExecution' | 'findByKey'
  >;
  readonly operations: Pick<
    WorkflowOperationServiceShape,
    'recordTurnObservation' | 'fixTurnAssociation'
  >;
  readonly catalog: WorkflowArtifactCatalogService;
  /** The durable harness ledger's turn edges for a session. A read; never a write to a PTY. */
  readonly turnEdges: (
    agentSessionId: number,
  ) => Effect.Effect<readonly WorkflowObservedTurnEdge[], unknown>;
}

export function makeWaitResolver(deps: WaitResolverDeps): WaitResolver {
  /**
   * Degradations this incarnation has already reported, keyed by what is broken.
   *
   * An unreadable payload is a *permanent* defect and its wait stays armed, while reconciliation is
   * woken by every turn and settlement anywhere in the runtime. Appending on each pass would let one
   * corrupt payload write unbounded retained history as unrelated work proceeds — history that is
   * kept indefinitely. Reporting once per incarnation keeps the fact visible without letting it
   * accumulate, and a fresh process reports again because "the runtime restarted and still cannot
   * read this" is worth saying once more.
   */
  const reported = new Set<string>();
  const context: ResolverContext = {
    ...deps,
    report: (input) => recordPayloadDegradation(deps, reported, input),
  };

  const reconcileWait = (waitId: number): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const wait = yield* deps.runs.findWait(waitId);
      if (!wait || wait.status !== 'armed') return false;
      return yield* evaluate(context, wait);
    }).pipe(logAndIgnore(`wait ${waitId}`, false));

  const reconcileWaits = (runId?: number): Effect.Effect<number> =>
    Effect.gen(function* () {
      const waits = yield* deps.runs.listArmedWaits(runId);
      let delivered = 0;
      for (const wait of waits) {
        if (yield* reconcileWait(wait.id)) delivered += 1;
      }
      return delivered;
    }).pipe(logAndIgnore('armed waits', 0));

  return { reconcileWait, reconcileWaits };
}

/**
 * Subscribes the resolver to the events that can satisfy a wait.
 *
 * Every one of them is a *hint*: the durable rows — the harness ledger, the operation records — are
 * what say whether a wait is satisfied, so a dropped notification costs a delay until the next
 * reconciliation rather than a lost result.
 */
export function startWaitResolver(input: {
  readonly resolver: WaitResolver;
  readonly eventBus: InternalRuntimeEventBusService;
  /** Wakes the dispatcher once a wait has advanced a run to `ready`. */
  readonly poke: Effect.Effect<void>;
}) {
  return Effect.gen(function* () {
    const subscription = yield* input.eventBus.subscribe({
      types: ['turn_started', 'turn_ended', 'turn_failed', 'workflow_operation_settled'],
    });
    yield* Effect.addFinalizer(() => subscription.unsubscribe);
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const event = yield* subscription.take;
          const runId = event.type === 'workflow_operation_settled' ? event.runId : undefined;
          const delivered = yield* input.resolver.reconcileWaits(runId);
          if (delivered > 0) yield* input.poke;
        }).pipe(
          Effect.catchAllCause((cause) =>
            Effect.sync(() => {
              console.warn('[runtime] Workflow wait resolution failed', cause);
            }),
          ),
        ),
      ),
    );
  });
}

function evaluate(
  deps: ResolverContext,
  wait: WorkflowWaitRecord,
): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    const declaration = yield* readDeclaration(deps, wait);
    if (!declaration) return false;

    // A human wait is never satisfied here. Somebody has to answer it, and inventing an answer is
    // the one thing a gate exists to prevent.
    if (declaration.kind === 'user_continue' || declaration.kind === 'user_input') return false;

    const event =
      declaration.kind === 'agent_turn'
        ? yield* agentTurnEvent(deps, wait, declaration)
        : yield* headlessEvent(deps, declaration);
    if (!event) return false;
    return yield* deliver(deps, wait, event);
  });
}

/**
 * Delivering an event, which needs the pin loaded first.
 *
 * The routing edge is a property of the pinned structure, and the position union deliberately has
 * no place to put "the wait we arrived through". So the edge is resolved here, from the code the run
 * is actually executing, rather than defaulted to something the router would then fail on.
 */
function deliver(
  deps: ResolverContext,
  wait: WorkflowWaitRecord,
  event: NodeEvent,
): Effect.Effect<boolean, DatabaseError | PayloadPublishError | unknown> {
  return Effect.gen(function* () {
    const run = yield* deps.runs.findRun(wait.runId);
    const execution = yield* deps.runs.findExecution(wait.executionId);
    if (!run || !execution || !wait.condition) return false;
    const storedDeclaration = yield* deps.payloads.resolve(wait.condition).pipe(Effect.either);
    const recovery =
      storedDeclaration._tag === 'Right' ? recoveryWaitDeclaration(storedDeclaration.right) : null;
    if (recovery) {
      const delivery = yield* deps.runs.deliverWait({
        waitId: wait.id,
        event: { value: event },
        resumePosition: recovery.isagiRecovery.resumePosition,
      });
      return delivery.ok && delivery.value.outcome === 'advanced';
    }
    const frame = yield* deps.runs.findFrame(execution.frameId);
    if (!frame) return false;

    const artifact = yield* deps.catalog
      .loadPinned({ artifactHash: run.artifactHash, workflowKey: run.workflowKey })
      .pipe(Effect.either);
    if (artifact._tag === 'Left') {
      // The event stays on the wait for the next evaluation. Delivering without an edge would write
      // a `routing` position naming nothing, which is precisely what the position union forbids.
      console.warn('[runtime] A wait could not be delivered because its pin did not load', {
        runId: run.id,
        waitId: wait.id,
        reason: artifact.left._tag === 'WorkflowLoadError' ? artifact.left.reason : 'database',
      });
      return false;
    }
    const graph = artifact.right.graphs.get(frame.graphKey);
    const edge = graph ? edgeFromNode(graph, execution.nodeId) : null;
    if (!edge) {
      console.warn('[runtime] A wait could not be delivered because its node has no single edge', {
        runId: run.id,
        waitId: wait.id,
        nodeId: execution.nodeId,
      });
      return false;
    }

    const delivery = yield* deps.runs.deliverWait({
      waitId: wait.id,
      event: { value: event },
      edgeId: edge.id,
    });
    return delivery.ok && delivery.value.outcome === 'advanced';
  });
}

/**
 * Whether the turn this wait is watching has finished.
 *
 * The association between our submission and a native turn is a watermark inference, fixed once and
 * never revisited: after it, a later start is ordinary session activity rather than ambiguity, and
 * the terminal paired to the fixed start is delivered whatever it says — including an interruption
 * the harness explains as a new start superseding it.
 */
function agentTurnEvent(
  deps: ResolverContext,
  wait: WorkflowWaitRecord,
  declaration: Extract<WaitDeclaration, { kind: 'agent_turn' }>,
): Effect.Effect<NodeEvent | null, unknown> {
  return Effect.gen(function* () {
    const recovery = recoveryWaitDeclaration(declaration);
    if (recovery) {
      const edges = yield* deps
        .turnEdges(recovery.target.agentSessionId)
        .pipe(Effect.orElseSucceed(() => [] as readonly WorkflowObservedTurnEdge[]));
      const terminal = terminalForRecovery(recovery, edges);
      return terminal ? turnEventOf(terminal) : null;
    }
    const boundary = {
      agentSessionId: declaration.target.agentSessionId,
      sentAt: declaration.target.sentAt,
    };
    const edges = yield* deps
      .turnEdges(boundary.agentSessionId)
      .pipe(Effect.orElseSucceed(() => [] as readonly WorkflowObservedTurnEdge[]));
    const submission = yield* submissionOperationOf(deps, wait, declaration.target.sentAt);

    // A fixed association is durable on the operation, so a restart re-reads it rather than
    // re-deciding it. Without one — an author-supplied target, say — selection runs from the
    // watermark, which is the same rule applied to the same evidence.
    const association =
      submission?.correlatedHarnessSessionId != null
        ? ({
            kind: 'fixed',
            harnessSessionId: submission.correlatedHarnessSessionId,
            startSeq: submission.correlatedStartSeq,
          } as const)
        : selectTurnAssociation(boundary, edges);

    if (association.kind === 'pending') return null;
    if (association.kind === 'ambiguous') {
      if (submission) {
        yield* deps.operations.recordTurnObservation({
          operationId: submission.id,
          observation: {
            kind: 'uncertain',
            detail: `ambiguous_turn_attribution:${association.startCount}`,
          },
        });
      }
      return null;
    }

    // Freeze it now, not when a terminal eventually arrives. Selection reads evidence that keeps
    // growing, so leaving it unfrozen would let a second start turn a perfectly explainable turn
    // into ambiguity on the next pass — and would leave a completed operation with no correlation
    // for inspection to show.
    if (submission && submission.correlatedHarnessSessionId === null) {
      yield* deps.operations.fixTurnAssociation({
        operationId: submission.id,
        attribution: 'inferred_by_watermark',
        startSeq: association.startSeq,
        harnessSessionId: association.harnessSessionId,
      });
    }

    const terminal = terminalForFixedAssociation(
      {
        agentSessionId: boundary.agentSessionId,
        sentAt: boundary.sentAt,
        harnessSessionId: association.harnessSessionId,
        startSeq: association.startSeq,
      },
      edges,
    );
    if (!terminal) return null;

    const event = turnEventOf(terminal);
    if (submission) {
      yield* deps.operations.recordTurnObservation({
        operationId: submission.id,
        observation: {
          kind: 'settled',
          state:
            event.outcome === 'ended'
              ? 'completed'
              : event.outcome === 'failed'
                ? 'failed'
                : 'interrupted',
          result: event,
        },
      });
    }
    return event;
  });
}

/**
 * Whether every member of a multi-operation wait has settled.
 *
 * All or none: results reach the router in the author's declared input order, so the wait resolves
 * once, with a complete set, rather than waking the router repeatedly with a growing list.
 */
function headlessEvent(
  deps: ResolverContext,
  declaration: Extract<WaitDeclaration, { kind: 'headless_agent' }>,
): Effect.Effect<NodeEvent | null, unknown> {
  return Effect.gen(function* () {
    const results: HeadlessOperationResult[] = [];
    for (const handle of declaration.operations) {
      const record = yield* deps.operationRecords.findByKey(handle.operationId);
      if (!record) return null;
      // `uncertain` never resolves: the run is blocked on it, and fabricating an outcome here is
      // exactly the operator assertion the design refuses to allow.
      if (
        record.state === 'intended' ||
        record.state === 'dispatched' ||
        record.state === 'uncertain'
      ) {
        return null;
      }
      if (record.result === null) {
        // No result slot at all. An `abandoned` operation crossed no boundary, so there is genuinely
        // nothing to report and the record's own state is the whole story.
        results.push(resultWithoutSlot(handle.operationId, record));
        continue;
      }
      const stored = yield* deps.payloads.resolve(record.result).pipe(Effect.either);
      if (stored._tag === 'Left') {
        // A slot that exists and will not resolve is *not* an absent result. Falling through to the
        // synthesized shape would hand the author's router a `completed` with none of the recorded
        // output — a fabricated success. The wait stays armed and the failure is recorded instead.
        yield* deps.report({
          runId: record.runId,
          executionId: record.executionId,
          what: `result of operation ${record.operationKey}`,
          ref: stored.left.ref,
          cause: stored.left.cause,
        });
        return null;
      }
      results.push(headlessResultOf(handle.operationId, record, stored.right));
    }
    return { kind: 'headless_agent', results };
  });
}

/**
 * Records that a payload needed to evaluate a wait could not be read.
 *
 * Missing or corrupt content is explicit degradation, never a substituted value: the run keeps its
 * armed wait — it is not dispatching, so nothing unsafe proceeds — and the reason is durable and
 * inspectable rather than a silence that looks like the world simply has not answered yet.
 */
/**
 * The resolver's own dependencies plus the one thing only the resolver instance can supply: a
 * degradation reporter that remembers what this incarnation has already said.
 */
interface ResolverContext extends WaitResolverDeps {
  readonly report: (input: PayloadDegradation) => Effect.Effect<void, unknown>;
}

interface PayloadDegradation {
  readonly runId: number;
  readonly executionId: number;
  readonly what: string;
  readonly ref: string;
  readonly cause: 'missing' | 'corrupt';
}

/**
 * Reports a degradation at most once, where "once" means once *durably*.
 *
 * The fingerprint is reserved before the write so two evaluations in flight cannot both append, and
 * released again unless the write commits. Marking it on the attempt instead would let a single
 * transient database failure suppress every later try — leaving the armed wait visibly unresolved
 * with nothing on record explaining why, which is the whole failure this reporter exists to prevent.
 */
function recordPayloadDegradation(
  deps: WaitResolverDeps,
  reported: Set<string>,
  input: PayloadDegradation,
): Effect.Effect<void, unknown> {
  const fingerprint = `${input.runId}:${input.what}:${input.ref}:${input.cause}`;
  if (reported.has(fingerprint)) return Effect.void;
  reported.add(fingerprint);
  const release = Effect.sync(() => {
    reported.delete(fingerprint);
  });
  return deps.runs
    .appendDiagnostic({
      runId: input.runId,
      kind: 'log',
      executionId: input.executionId,
      detail: {
        value: {
          source: 'runtime_diagnostic',
          code: 'payload_unavailable',
          level: 'error',
          message: `The ${input.what} could not be read (${input.cause} reference ${input.ref}), so this wait cannot be evaluated.`,
          payloadRef: input.ref,
          cause: input.cause,
        },
      },
    })
    .pipe(
      // A rejection is as much "not recorded" as a raised failure: the caller asked for a durable
      // fact and did not get one, so the next pass must be free to ask again.
      Effect.flatMap((written) => (written.ok ? Effect.void : release)),
      Effect.tapErrorCause(() => release),
    );
}

/** The result a record implies when it carries no result slot of its own. */
function resultWithoutSlot(
  operationId: string,
  record: WorkflowOperationRecord,
): HeadlessOperationResult {
  return {
    operationId,
    status: record.state === 'completed' ? 'completed' : 'failed',
    ...(record.uncertaintyDetail === null ? {} : { error: record.uncertaintyDetail }),
  };
}

/** A resolved result slot, read back as the author's edge will see it. */
function headlessResultOf(
  operationId: string,
  record: WorkflowOperationRecord,
  stored: unknown,
): HeadlessOperationResult {
  if (stored && typeof stored === 'object' && 'status' in stored) {
    return { ...(stored as HeadlessOperationResult), operationId };
  }
  // The slot resolved but holds nothing recognizable. The record's own state is then the only
  // honest account of what happened; no output is invented for it.
  return resultWithoutSlot(operationId, record);
}

/** The recorded submission whose watermark this wait is bounded by. */
function submissionOperationOf(
  deps: ResolverContext,
  wait: WorkflowWaitRecord,
  sentAt: string,
): Effect.Effect<WorkflowOperationRecord | null, unknown> {
  return deps.operationRecords
    .listForExecution(wait.executionId)
    .pipe(
      Effect.map(
        (records) =>
          records.find(
            (record) =>
              record.submissionWatermark === sentAt &&
              (record.capability === 'send_agent_prompt' ||
                record.capability === 'spawn_agent_session'),
          ) ?? null,
      ),
    );
}

function readDeclaration(
  deps: ResolverContext,
  wait: WorkflowWaitRecord,
): Effect.Effect<WaitDeclaration | null, unknown> {
  if (!wait.condition) return Effect.succeed(null);
  return Effect.gen(function* () {
    const resolved = yield* deps.payloads.resolve(wait.condition!).pipe(Effect.either);
    if (resolved._tag === 'Left') {
      // Without its declaration a wait cannot be evaluated at all. Returning silently would leave
      // the run sitting on an armed wait that nothing will ever satisfy, looking exactly like a
      // world that has not answered yet.
      yield* deps.report({
        runId: wait.runId,
        executionId: wait.executionId,
        what: `declaration of wait ${wait.id}`,
        ref: resolved.left.ref,
        cause: resolved.left.cause,
      });
      return null;
    }
    const parsed = validateWaitDeclaration(resolved.right);
    return parsed.ok ? parsed.value : null;
  });
}

function logAndIgnore<A>(what: string, fallback: A) {
  return <E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, never, R> =>
    effect.pipe(
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          console.warn(`[runtime] Workflow wait resolution failed for ${what}`, cause);
          return fallback;
        }),
      ),
    );
}
