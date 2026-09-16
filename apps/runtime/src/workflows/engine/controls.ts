import type { StructureDiagnostic } from '@yourtechbudstudio/isagi-workflow-verifier/structure';
import { Effect } from 'effect';

import type { DatabaseError } from '../../persistence/index.js';
import type { WorkflowOperationServiceShape } from '../operations/operation.service.js';
import type { WorkflowOperationsRepositoryService } from '../persistence/operations.repository.js';
import type {
  PayloadPublishError,
  WorkflowPayloadStoreService,
} from '../persistence/payload-store.js';
import type { WorkflowExecutionRecord, WorkflowRunRecord } from '../persistence/records.js';
import { isPlainObject } from '../state/reducers.js';
import { validateSavedPositions } from '../structure/retry-validation.js';
import { WorkflowEngineError, type WorkflowUserInputAnswers } from '../types.js';
import type { WaitResolver } from '../waits/resolver.js';
import {
  validateWorkflowUserInputAnswers,
  WorkflowUserInputValidationError,
} from '../waits/user-input.js';
import { resolveArtifact, type LaunchDeps } from './launch.js';
import { edgeFromNode } from './structure.js';

/**
 * The six controls, and the preconditions the runtime owns for each.
 *
 * Two fence classes meet here and they are deliberately different. A *prepared* control — one that
 * resolved an artifact, validated structure or reconciled operations outside the transaction —
 * commits only if `control_revision` is unchanged, so a newer Pause, Cancel or Retry wins over a
 * stale decision. A claimed attempt's *result*, by contrast, is never fenced on the revision, which
 * is what makes "the revision changed" structurally incapable of dropping an outcome somebody
 * already produced.
 */
export type ControlResult = {
  readonly runId: number;
  readonly accepted: boolean;
  readonly status: WorkflowRunRecord['status'];
  readonly revision: number;
  readonly diagnostics: readonly StructureDiagnostic[];
};

export type ControlError = WorkflowEngineError | DatabaseError | PayloadPublishError;

export interface ControlDeps extends LaunchDeps {
  readonly payloads: WorkflowPayloadStoreService;
  readonly operationRecords: Pick<
    WorkflowOperationsRepositoryService,
    'listForExecution' | 'findByKey' | 'findById' | 'findBlockingObligation'
  >;
  readonly operations: Pick<
    WorkflowOperationServiceShape,
    'reconcileExecution' | 'stopOwnedOperations'
  >;
  readonly waits: WaitResolver;
  /** Wakes the dispatcher after a control made a run dispatchable again. */
  readonly poke: Effect.Effect<void>;
}

export function makeControls(deps: ControlDeps) {
  return {
    pause: (runId: number) => pause(deps, runId),
    resume: (runId: number) => resume(deps, runId),
    retry: (runId: number) => retry(deps, runId),
    cancel: (runId: number) => cancel(deps, runId),
    dismiss: (runId: number) => dismiss(deps, runId),
    advance: (input: {
      readonly runId: number;
      readonly waitId: number;
      readonly answers?: Record<string, unknown> | undefined;
    }) => advance(deps, input),
  };
}

/**
 * Pause gates *future* dispatch. It does not revoke an in-flight callback's permission to record or
 * to commit: that callback reaches its durable boundary normally, and the gate stops the next claim.
 * Already-launched external operations keep running and their waits keep resolving.
 */
function pause(deps: ControlDeps, runId: number): Effect.Effect<ControlResult, ControlError> {
  return Effect.gen(function* () {
    const run = yield* requireRun(deps, runId);
    if (isTerminal(run)) return yield* staleControl(run, 'pause');
    const applied = yield* deps.runs.applyPause({ runId, controlRevision: run.controlRevision });
    return yield* resultOf(deps, run, applied);
  });
}

/**
 * Resume loads only the run's **current pin** — never discovery, never a newer artifact — and
 * reconciles before lifting the gate. `command`, `validate` and a committed graph initialization
 * never run again; an uncommitted callback may re-enter, and only after its operations have been
 * settled.
 */
function resume(deps: ControlDeps, runId: number): Effect.Effect<ControlResult, ControlError> {
  return Effect.gen(function* () {
    const run = yield* requireRun(deps, runId);
    if (isTerminal(run)) return yield* staleControl(run, 'resume');

    const loaded = yield* deps.catalog
      .loadPinned({ artifactHash: run.artifactHash, workflowKey: run.workflowKey })
      .pipe(Effect.either);
    if (loaded._tag === 'Left') {
      const failure = loaded.left;
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_load_failed',
          message:
            failure._tag === 'WorkflowLoadError'
              ? `The version this run is pinned to could not be loaded: ${failure.message}`
              : failure.message,
          workflowKey: run.workflowKey,
          workflowRunId: run.id,
          artifactHash: run.artifactHash,
          ...(failure._tag === 'WorkflowLoadError'
            ? { workflowLoadFailureReason: failure.reason }
            : {}),
        }),
      );
    }

    // Reconciliation before the gate lifts, so the first claim after Resume meets settled receipts.
    // An uncertain operation leaves the run blocked and Resume does not pretend otherwise.
    if (run.position.kind === 'node_callback') {
      const reconciled = yield* deps.operations.reconcileExecution(run.position.executionId);
      if (reconciled.uncertainOperationId !== null) {
        return yield* operationUncertain(deps, run, reconciled.uncertainOperationId);
      }
    }
    yield* deps.waits.reconcileWaits(run.id);

    const applied = yield* deps.runs.applyResume({
      runId,
      controlRevision: run.controlRevision,
      expectedPosition: run.position,
    });
    if (!applied.ok && applied.rejection.kind === 'environment_unavailable') {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_environment_unavailable',
          message: `This run's destination no longer exists, so it cannot be resumed.`,
          workflowRunId: run.id,
          ...(applied.rejection.worktreeId === null
            ? {}
            : { worktreeId: applied.rejection.worktreeId }),
          ...(applied.rejection.surfaceId === null
            ? {}
            : { surfaceId: applied.rejection.surfaceId }),
        }),
      );
    }
    const result = yield* resultOf(deps, run, applied);
    if (result.accepted) yield* deps.poke;
    return result;
  });
}

/**
 * Retry adopts the **latest verified** version, and only if it still fits where the run is parked.
 *
 * Resolution, loading and structural validation all happen outside the transaction, so the adoption
 * is a prepared action fenced on the control revision, the same failed position and the same
 * ownership. A failure at any of those steps leaves state, pin, position, attempts and adoption
 * history byte-identical — and a successful adoption that then fails semantically under the new code
 * is an ordinary new failed attempt, never an automatic rollback.
 */
function retry(deps: ControlDeps, runId: number): Effect.Effect<ControlResult, ControlError> {
  return Effect.gen(function* () {
    const run = yield* requireRun(deps, runId);
    if (run.status !== 'failed' && run.status !== 'blocked') {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_run_not_retryable',
          message: `Only a failed or blocked run can be retried; this one is ${run.status}.`,
          workflowRunId: run.id,
        }),
      );
    }
    // Retry cannot manufacture an outcome for an effect nobody can account for, so unresolved
    // uncertainty blocks it outright rather than being repinned around.
    const obligation = yield* deps.operationRecords.findBlockingObligation(run.id);
    if (obligation) return yield* operationUncertain(deps, run, obligation.id);

    const worktreeId = run.destination.worktreeId;
    if (worktreeId === null) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_environment_unavailable',
          message: 'This run has no destination worktree, so a current version cannot be resolved.',
          workflowRunId: run.id,
        }),
      );
    }
    const artifact = yield* resolveArtifact(deps, run.workflowKey, worktreeId);

    const diagnostics = yield* validateAdoption(deps, run, artifact.descriptor);
    if (diagnostics.length > 0) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_structure_validation_failed',
          message: 'The latest verified version no longer fits where this run is parked.',
          workflowKey: run.workflowKey,
          workflowRunId: run.id,
          artifactHash: artifact.artifactHash,
          diagnostics,
        }),
      );
    }

    const applied = yield* deps.runs.adoptRetryPin({
      runId,
      controlRevision: run.controlRevision,
      artifactHash: artifact.artifactHash,
      expectedPosition: run.position,
      expectedOwner: run.owner,
    });
    const result = yield* resultOf(deps, run, applied);
    if (result.accepted) yield* deps.poke;
    return result;
  });
}

/**
 * Cancel stops successors and new effects; it never deletes anything and never claims the external
 * world stopped with it.
 *
 * Every record is kept — snapshots, frames, attempts, transitions, operations, receipts and payload
 * references — and a late callback result or external completion is retained as cancelled-attempt
 * evidence. Stopping is attempted, bounded, and reported separately, because a stop whose outcome
 * nobody observed is not a stopped process.
 */
function cancel(deps: ControlDeps, runId: number): Effect.Effect<ControlResult, ControlError> {
  return Effect.gen(function* () {
    const run = yield* requireRun(deps, runId);
    if (isTerminal(run)) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_run_not_cancellable',
          message: `This run has already stopped (${run.status}).`,
          workflowRunId: run.id,
        }),
      );
    }
    const applied = yield* deps.runs.applyCancel({ runId, controlRevision: run.controlRevision });
    const result = yield* resultOf(deps, run, applied);
    if (result.accepted) {
      yield* deps.operations.stopOwnedOperations({ runId, reason: 'run_cancelled' });
    }
    return result;
  });
}

/**
 * Dismiss releases a stopped run's surface attachment, and nothing else.
 *
 * An active run must be cancelled first. Detaching live work would take the surface back while the
 * work carried on, which is the one outcome the retention policy calls dishonest — so this is a
 * refusal rather than a silent alternative to stopping.
 */
function dismiss(deps: ControlDeps, runId: number): Effect.Effect<ControlResult, ControlError> {
  return Effect.gen(function* () {
    const run = yield* requireRun(deps, runId);
    const applied = yield* deps.runs.detachRun({ runId, controlRevision: run.controlRevision });
    if (!applied.ok && applied.rejection.kind === 'run_active') {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_run_not_dismissible',
          message: `This run is still ${applied.rejection.status}. Cancel it before dismissing it.`,
          workflowRunId: run.id,
        }),
      );
    }
    return yield* resultOf(deps, run, applied);
  });
}

/**
 * Answering a human gate.
 *
 * Addressed by wait id, so a stale form cannot satisfy another visit's wait, and idempotent: a
 * second submission reports that the wait is already resolved and writes nothing. Readiness is
 * recorded even while the run is paused — readiness is not dispatch — and no future gate is
 * satisfied in advance.
 */
function advance(
  deps: ControlDeps,
  input: {
    readonly runId: number;
    readonly waitId: number;
    readonly answers?: Record<string, unknown> | undefined;
  },
): Effect.Effect<ControlResult, ControlError> {
  return Effect.gen(function* () {
    const run = yield* requireRun(deps, input.runId);
    const wait = yield* deps.runs.findWait(input.waitId);
    if (!wait || wait.runId !== run.id) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_wait_not_found',
          message: `Wait ${input.waitId} does not belong to run ${run.id}.`,
          workflowRunId: run.id,
        }),
      );
    }
    if (wait.status !== 'armed') {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_wait_already_resolved',
          message: `Wait ${wait.id} is already ${wait.status}.`,
          workflowRunId: run.id,
        }),
      );
    }
    if (wait.waitKind !== 'user_continue' && wait.waitKind !== 'user_input') {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_wait_not_found',
          message: `Wait ${wait.id} is waiting on ${wait.waitKind}, which nobody can answer by hand.`,
          workflowRunId: run.id,
        }),
      );
    }
    const event = yield* humanEvent(deps, wait.id, wait.waitKind, input.answers ?? {});
    const edgeId = yield* routingEdgeOf(deps, run, wait.executionId);
    const delivered = yield* deps.runs.consumeHumanWait({
      waitId: wait.id,
      event: { value: event },
      edgeId,
    });
    // A blocked run is holding an external effect nobody can account for. Answering an unrelated
    // gate says nothing about that effect, so the delivery transaction refuses it — atomically with
    // the status it is refusing against, rather than on a check this control made a moment earlier.
    // Cancel, or settling the operation, are the ways out.
    if (!delivered.ok && delivered.rejection.kind === 'run_blocked') {
      const blocking = delivered.rejection.blockedOperationId;
      return yield* operationUncertain(deps, run, blocking);
    }
    if (!delivered.ok && delivered.rejection.kind === 'wait_already_resolved') {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_wait_already_resolved',
          message: `Wait ${wait.id} is already ${delivered.rejection.status}.`,
          workflowRunId: run.id,
        }),
      );
    }
    const result = yield* resultOf(deps, run, delivered);
    if (result.accepted) yield* deps.poke;
    return result;
  });
}

function humanEvent(
  deps: ControlDeps,
  waitId: number,
  kind: 'user_continue' | 'user_input',
  answers: Record<string, unknown>,
): Effect.Effect<Record<string, unknown>, ControlError> {
  if (kind === 'user_continue') return Effect.succeed({ kind: 'user_continue' });
  return Effect.gen(function* () {
    const wait = yield* deps.runs.findWait(waitId);
    const condition = wait?.condition
      ? yield* deps.payloads.resolve(wait.condition).pipe(Effect.orElseSucceed(() => null))
      : null;
    const questions =
      isPlainObject(condition) && Array.isArray(condition.questions) ? condition.questions : null;
    if (!questions) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_user_input_invalid',
          message: `Wait ${waitId} does not record the questions it asked, so an answer cannot be validated against it.`,
        }),
      );
    }
    const validated: WorkflowUserInputAnswers = yield* Effect.try({
      try: () => validateWorkflowUserInputAnswers({ questions, answers }),
      catch: (cause) =>
        new WorkflowEngineError({
          code: 'workflow_user_input_invalid',
          message:
            cause instanceof WorkflowUserInputValidationError ? cause.message : String(cause),
        }),
    });
    return { kind: 'user_input', answers: validated };
  });
}

/** Everything `validateSavedPositions` needs about where the run is parked. */
function validateAdoption(
  deps: ControlDeps,
  run: WorkflowRunRecord,
  descriptor: Parameters<typeof validateSavedPositions>[0]['descriptor'],
): Effect.Effect<readonly StructureDiagnostic[], ControlError> {
  return Effect.gen(function* () {
    const frames = yield* deps.runs.listActiveFrames(run.id);
    const parentExecutions = new Map<number, WorkflowExecutionRecord>();
    for (const frame of frames) {
      if (frame.parentExecutionId === null) continue;
      const parent = yield* deps.runs.findExecution(frame.parentExecutionId);
      if (parent) parentExecutions.set(parent.id, parent);
    }
    const executionId = 'executionId' in run.position ? (run.position.executionId as number) : null;
    const execution = executionId === null ? null : yield* deps.runs.findExecution(executionId);

    // A destination already chosen but not yet committed has to stay declared by the new code, or
    // the run would resume by routing somewhere the author has since removed.
    const pendingDestination =
      run.position.kind === 'routing' ? yield* pendingDestinationOf(deps, executionId) : null;

    return validateSavedPositions({
      descriptor,
      frames,
      position: run.position,
      execution,
      parentExecutions,
      pendingDestination,
    });
  });
}

function pendingDestinationOf(
  deps: ControlDeps,
  executionId: number | null,
): Effect.Effect<string | null, ControlError> {
  if (executionId === null) return Effect.succeed(null);
  return Effect.gen(function* () {
    const execution = yield* deps.runs.findExecution(executionId);
    if (!execution) return null;
    const saved = yield* deps.runs.findProducerOutput({
      frameId: execution.frameId,
      executionId,
      segmentKind: 'routing',
      segmentRef: null,
    });
    if (!saved) return null;
    const value = yield* deps.payloads
      .resolve(saved.slot)
      .pipe(Effect.orElseSucceed(() => null as unknown));
    return isPlainObject(value) && typeof value.to === 'string' ? value.to : null;
  });
}

/** The edge a delivered wait routes into, resolved from the run's own pin. */
function routingEdgeOf(
  deps: ControlDeps,
  run: WorkflowRunRecord,
  executionId: number,
): Effect.Effect<string, ControlError> {
  return Effect.gen(function* () {
    const execution = yield* deps.runs.findExecution(executionId);
    const frame = execution ? yield* deps.runs.findFrame(execution.frameId) : null;
    const artifact = yield* deps.catalog
      .loadPinned({ artifactHash: run.artifactHash, workflowKey: run.workflowKey })
      .pipe(Effect.either);
    const graph =
      artifact._tag === 'Right' && frame ? artifact.right.graphs.get(frame.graphKey) : undefined;
    const edge = graph && execution ? edgeFromNode(graph, execution.nodeId) : null;
    if (!edge) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_load_failed',
          message: `The version this run is pinned to does not declare a single edge out of the node this wait belongs to.`,
          workflowRunId: run.id,
          workflowKey: run.workflowKey,
          artifactHash: run.artifactHash,
        }),
      );
    }
    return edge.id;
  });
}

function requireRun(
  deps: ControlDeps,
  runId: number,
): Effect.Effect<WorkflowRunRecord, ControlError> {
  return deps.runs.findRun(runId).pipe(
    Effect.flatMap((run) =>
      run
        ? Effect.succeed(run)
        : Effect.fail(
            new WorkflowEngineError({
              code: 'workflow_run_not_found',
              message: `Workflow run ${runId} was not found.`,
              workflowRunId: runId,
            }),
          ),
    ),
  );
}

function operationUncertain(
  deps: ControlDeps,
  run: WorkflowRunRecord,
  operationId: number | null,
): Effect.Effect<never, ControlError> {
  return Effect.gen(function* () {
    const record = operationId === null ? null : yield* deps.operationRecords.findById(operationId);
    return yield* Effect.fail(
      new WorkflowEngineError({
        code: 'workflow_operation_uncertain',
        message:
          'This run is holding an external operation whose outcome cannot be established. It will not be resent, and no outcome can be assumed for it.',
        workflowRunId: run.id,
        ...(record ? { operationKey: record.operationKey } : {}),
      }),
    );
  });
}

function staleControl(run: WorkflowRunRecord, control: string): Effect.Effect<never, ControlError> {
  return Effect.fail(
    new WorkflowEngineError({
      code: 'workflow_stale_control',
      message: `This run has already stopped (${run.status}), so ${control} no longer applies.`,
      workflowRunId: run.id,
      operation: control,
    }),
  );
}

/**
 * The shape every control returns: what was accepted, and where the run is now.
 *
 * A control result is never an alternate snapshot authority — the read routes and the delta stream
 * are — so it stays narrow deliberately, and a refused prepared action reports `accepted: false`
 * rather than pretending.
 */
function resultOf(
  deps: ControlDeps,
  before: WorkflowRunRecord,
  applied: { readonly ok: boolean },
): Effect.Effect<ControlResult, ControlError> {
  return deps.runs.findRun(before.id).pipe(
    Effect.map((current) => {
      const run = current ?? before;
      return {
        runId: run.id,
        accepted: applied.ok,
        status: run.status,
        revision: run.revision,
        diagnostics: [],
      };
    }),
  );
}

function isTerminal(run: WorkflowRunRecord) {
  return run.status === 'done' || run.status === 'failed' || run.status === 'cancelled';
}
