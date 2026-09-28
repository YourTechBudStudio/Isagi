import { Effect } from 'effect';

import type { WorkflowUserInputAnswers } from '@isagi/contracts';

import { WorkflowEngineError, type WorkflowControl } from '../errors.js';
import { stopRunHeadless } from '../operations/headless.js';
import { errorMessage } from '../state/pure.js';
import { listOperations, settleOperation } from '../store/operations.js';
import { fromJson, now, toJson, type Db, type RunError, type RunRow } from '../store/rows.js';
import { getRun, updateRun } from '../store/runs.js';
import {
  findLeafExecution,
  findRetryTarget,
  findRootInvocation,
  getExecution,
  getInvocation,
  insertExecution,
  listInvocations,
  listExecutions,
  updateExecution,
  updateInvocation,
} from '../store/tree.js';
import { checkReload } from '../structure/reload.js';
import type { WorkflowQuestionSpec } from '../types.js';
import type { HeadlessOperationRecord } from '../waits/check.js';
import {
  validateWorkflowUserInputAnswers,
  WorkflowUserInputValidationError,
} from '../waits/user-input.js';
import { projectContext, resolveLatestBuild } from './builds.js';
import { prepareAndStart } from './prepare.js';
import type { SavedResult } from './results.js';
import type { EngineRuntime } from './runtime.js';

/**
 * The run controls. Each one checks the run's status, changes the rows it owns in one transaction,
 * appends its event, and wakes the driver when there is work to do.
 */

export function pause(rt: EngineRuntime, runId: number) {
  return rt.commit('workflow_pause', (db, emit) => {
    const run = requireRun(db, runId);
    if (run.status !== 'running' && run.status !== 'waiting') throw unavailable(run, 'pause');
    // An in-flight node function finishes and its result is saved; nothing new starts.
    updateRun(db, runId, { status: 'paused' });
    emit({
      runId,
      category: 'run',
      kind: 'run_paused',
      message: 'Paused',
      data: { reason: 'control' },
    });
  });
}

/** Reloads the latest verified build, then continues where the run is parked. */
export function resume(rt: EngineRuntime, runId: number) {
  return Effect.gen(function* () {
    const run = yield* rt.read('workflow_read_run', (db) => requireRun(db, runId));
    if (run.status !== 'paused' || run.surfaceId === null) {
      return yield* Effect.fail(unavailable(run, 'resume'));
    }
    const artifactHash = yield* reloadBuild(rt, run, 'parked');
    yield* rt.commit('workflow_resume', (db, emit) => {
      const current = requireRun(db, runId);
      if (current.status !== 'paused') throw unavailable(current, 'resume');
      switchBuild(db, emit, current, artifactHash);
      updateRun(db, runId, { status: 'running' });
      emit({ runId, category: 'run', kind: 'run_resumed', message: 'Resumed' });
    });
    // Waits are re-checked against a fresh observation of the agent session.
    rt.freshChecks.add(runId);
    rt.kick(runId);
  });
}

/**
 * Reloads the latest verified build, then retries where the run failed.
 *
 * A failed preparation (or a root `init` that threw) prepares again: saved ids skip what exists.
 * Otherwise a new execution row repeats the failed one (`retry_of`), copying its saved result and a
 * user's stored answer; with no saved result the node function runs again. An agent-turn wait is
 * re-checked after refreshing the session's observation, so a turn the person ran by hand counts.
 */
export function retry(rt: EngineRuntime, runId: number) {
  return Effect.gen(function* () {
    const run = yield* rt.read('workflow_read_run', (db) => requireRun(db, runId));
    const error = fromJson<RunError>(run.errorJson);
    const hasRoot = yield* rt.read('workflow_read_root', (db) => findRootInvocation(db, runId));
    const preparing = error?.stage === 'environment' || hasRoot === null;
    if (run.status !== 'failed' || (!preparing && run.surfaceId === null)) {
      return yield* Effect.fail(unavailable(run, 'retry'));
    }
    const artifactHash = yield* reloadBuild(rt, run, 'retry');

    if (preparing) {
      yield* rt.commit('workflow_retry_preparation', (db, emit) => {
        const current = requireRun(db, runId);
        if (current.status !== 'failed') throw unavailable(current, 'retry');
        switchBuild(db, emit, current, artifactHash);
        updateRun(db, runId, { status: 'preparing', errorJson: null, endedAt: null });
        emit({ runId, category: 'run', kind: 'run_retried', message: 'Retrying preparation' });
      });
      rt.fork(prepareAndStart(rt, runId), 'workflow preparation retry');
      return;
    }

    const target = yield* rt.read('workflow_read_retry_target', (db) => findRetryTarget(db, runId));
    if (!target) return yield* Effect.fail(unavailable(run, 'retry'));
    const result = fromJson<SavedResult>(target.resultJson);
    const agentWait =
      result?.type === 'suspend' && result.wait.kind === 'agent_turn' ? result.wait : null;
    if (agentWait) {
      yield* rt.deps.agents.turnEdges(agentWait.target.agentSessionId, true).pipe(
        Effect.mapError(
          (cause) =>
            new WorkflowEngineError({
              code: 'workflow_agent_observation_unavailable',
              message: `Agent session ${agentWait.target.agentSessionId} could not be observed again: ${errorMessage(cause)}`,
              workflowRunId: runId,
              agentSessionId: agentWait.target.agentSessionId,
            }),
        ),
      );
    }
    const userWait = result?.type === 'suspend' && result.wait.kind.startsWith('user_');

    yield* rt.commit('workflow_retry', (db, emit) => {
      const current = requireRun(db, runId);
      if (current.status !== 'failed') throw unavailable(current, 'retry');
      const hash = switchBuild(db, emit, current, artifactHash);
      const repeated = insertExecution(db, {
        runId,
        invocationId: target.invocationId,
        nodeId: target.nodeId,
        nodeKind: target.nodeKind,
        visitIndex: target.visitIndex,
        label: target.label,
        artifactHash: hash,
        retryOf: target.id,
        resultJson: target.resultJson,
        eventJson: userWait ? target.eventJson : null,
      });
      updateRun(db, runId, { status: 'running', errorJson: null, endedAt: null });
      emit({
        runId,
        executionId: repeated.id,
        category: 'run',
        kind: 'run_retried',
        message: `Retrying ${target.label ?? target.nodeId}`,
        data: { retryOf: target.id, reusesResult: target.resultJson !== null },
      });
      emit({
        runId,
        executionId: repeated.id,
        category: 'node',
        kind: 'node_started',
        message: `Started ${target.label ?? target.nodeId} again`,
        data: { nodeId: target.nodeId, nodeKind: target.nodeKind, retryOf: target.id },
      });
    });
    rt.kick(runId);
  });
}

/**
 * Stops the run. Its open executions, graph invocations and running headless jobs end in the same
 * write; the processes are then stopped best effort. Agent panes stay open.
 */
export function cancel(rt: EngineRuntime, runId: number) {
  return Effect.gen(function* () {
    yield* rt.commit('workflow_cancel', (db, emit) => {
      const run = requireRun(db, runId);
      if (!['preparing', 'running', 'waiting', 'paused', 'failed'].includes(run.status)) {
        throw unavailable(run, 'cancel');
      }
      const endedAt = now();
      for (const execution of listExecutions(db, runId)) {
        if (execution.status === 'running' || execution.status === 'waiting') {
          updateExecution(db, execution.id, { status: 'cancelled', endedAt });
        }
      }
      for (const invocation of listInvocations(db, runId)) {
        if (invocation.status === 'running') {
          updateInvocation(db, invocation.id, { status: 'cancelled', endedAt });
        }
      }
      // Its running headless jobs end here too, so the run and its operations never disagree;
      // stopping their processes comes after, and writes nothing but a failed stop.
      for (const operation of listOperations(db, { runId, status: 'running' })) {
        if (operation.kind !== 'run_headless') continue;
        settleOperation(db, emit, operation.id, 'interrupted', {
          resultJson: toJson({ error: 'cancelled' } satisfies HeadlessOperationRecord),
        });
      }
      updateRun(db, runId, { status: 'cancelled', endedAt });
      emit({ runId, category: 'run', kind: 'run_cancelled', message: 'Cancelled' });
    });
    yield* stopRunHeadless(rt, runId);
  });
}

/** Detaches a finished run from its surface so another run can use it. */
export function dismiss(rt: EngineRuntime, runId: number) {
  return rt.commit('workflow_dismiss', (db, emit) => {
    const run = requireRun(db, runId);
    if (!['completed', 'failed', 'cancelled'].includes(run.status) || run.surfaceId === null) {
      throw unavailable(run, 'dismiss');
    }
    updateRun(db, runId, { surfaceId: null });
    emit({
      runId,
      category: 'run',
      kind: 'run_dismissed',
      message: 'Dismissed',
      data: { surfaceId: run.surfaceId },
    });
  });
}

/**
 * Answers a `user_continue` or `user_input` wait. Stored even while paused, when routing waits for
 * Resume.
 */
export function advance(
  rt: EngineRuntime,
  input: {
    readonly runId: number;
    readonly executionId: number;
    readonly answers?: WorkflowUserInputAnswers | undefined;
  },
) {
  return Effect.gen(function* () {
    const paused = yield* rt.commit('workflow_advance', (db, emit) => {
      const run = requireRun(db, input.runId);
      if (!['running', 'waiting', 'paused'].includes(run.status)) throw unavailable(run, 'advance');
      const execution = getExecution(db, input.executionId);
      const result = execution ? fromJson<SavedResult>(execution.resultJson) : null;
      const wait = result?.type === 'suspend' ? result.wait : null;
      if (
        !execution ||
        execution.runId !== input.runId ||
        (execution.status !== 'running' && execution.status !== 'waiting') ||
        execution.eventJson !== null ||
        !wait ||
        (wait.kind !== 'user_continue' && wait.kind !== 'user_input')
      ) {
        throw new WorkflowEngineError({
          code: 'workflow_wait_not_found',
          message: `Execution ${input.executionId} is not waiting for the user.`,
          workflowRunId: input.runId,
          executionId: input.executionId,
        });
      }
      const event =
        wait.kind === 'user_continue'
          ? continueEvent(input)
          : { kind: 'user_input' as const, answers: validAnswers(input, wait.questions) };
      updateExecution(db, execution.id, { eventJson: toJson(event) });
      emit({
        runId: input.runId,
        executionId: execution.id,
        category: 'node',
        kind: 'wait_delivered',
        message: wait.kind === 'user_continue' ? 'Continued' : 'Answered',
        data: event,
      });
      return run.status === 'paused';
    });
    if (!paused) rt.kick(input.runId);
  });
}

/**
 * Moves the run to the build a reload resolved, recording a `code_reloaded` event when it changed.
 * Returns the hash the run now uses.
 */
function switchBuild(
  db: Db,
  emit: Parameters<Parameters<EngineRuntime['commit']>[1]>[1],
  run: RunRow,
  artifactHash: string,
): string {
  if (artifactHash === run.artifactHash) return artifactHash;
  updateRun(db, run.id, { artifactHash });
  emit({
    runId: run.id,
    category: 'run',
    kind: 'code_reloaded',
    message: 'Reloaded the latest build',
    data: { from: run.artifactHash, to: artifactHash },
  });
  return artifactHash;
}

/**
 * Resolves the latest verified build and checks it still fits where the run is parked (or where a
 * Retry will repeat). A refusal leaves the run unchanged.
 */
function reloadBuild(
  rt: EngineRuntime,
  run: RunRow,
  position: 'parked' | 'retry',
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const build = yield* resolveLatestBuild(
      rt,
      run.workflowKey,
      yield* projectContext(rt, run.projectId),
    );
    const diagnostics = yield* rt.read('workflow_reload_position', (db) => {
      const parked =
        position === 'parked' ? findLeafExecution(db, run.id) : findRetryTarget(db, run.id);
      const open = listInvocations(db, run.id).filter(
        (invocation) => invocation.status === 'running',
      );
      return checkReload(build.descriptor, {
        invocations: open.map((invocation) => {
          const enteredBy =
            invocation.parentExecutionId === null
              ? null
              : getExecution(db, invocation.parentExecutionId);
          const parentGraph = enteredBy
            ? getInvocation(db, enteredBy.invocationId)?.graphKey
            : null;
          return {
            graphKey: invocation.graphKey,
            enteredBy:
              enteredBy && parentGraph ? { graphKey: parentGraph, nodeId: enteredBy.nodeId } : null,
          };
        }),
        parked: parked
          ? {
              graphKey: getInvocation(db, parked.invocationId)?.graphKey ?? '',
              nodeId: parked.nodeId,
              nodeKind: parked.nodeKind,
            }
          : null,
      });
    });
    if (diagnostics.length > 0) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_code_incompatible',
          message: `The latest build no longer fits where run ${run.id} is parked: ${diagnostics[0]?.message}`,
          workflowKey: run.workflowKey,
          workflowRunId: run.id,
          diagnostics,
        }),
      );
    }
    return build.artifactHash;
  });
}

function continueEvent(input: { readonly answers?: WorkflowUserInputAnswers | undefined }) {
  if (input.answers !== undefined) {
    throw new WorkflowEngineError({
      code: 'workflow_user_input_invalid',
      message: 'A continue wait takes no answers.',
    });
  }
  return { kind: 'user_continue' as const };
}

function validAnswers(
  input: { readonly answers?: WorkflowUserInputAnswers | undefined },
  questions: readonly WorkflowQuestionSpec[],
) {
  try {
    return validateWorkflowUserInputAnswers({ questions, answers: { ...(input.answers ?? {}) } });
  } catch (cause) {
    if (cause instanceof WorkflowUserInputValidationError) {
      throw new WorkflowEngineError({
        code: 'workflow_user_input_invalid',
        message: cause.message,
      });
    }
    throw cause;
  }
}

function requireRun(db: Db, runId: number): RunRow {
  const run = getRun(db, runId);
  if (!run) {
    throw new WorkflowEngineError({
      code: 'workflow_run_not_found',
      message: `Workflow run ${runId} was not found.`,
      workflowRunId: runId,
    });
  }
  return run;
}

function unavailable(run: RunRow, control: WorkflowControl) {
  return new WorkflowEngineError({
    code: 'workflow_control_unavailable',
    message:
      run.surfaceId === null &&
      (control === 'resume' || control === 'retry' || control === 'dismiss')
        ? `Run ${run.id} has no surface, so it cannot ${control}.`
        : `Run ${run.id} is ${run.status}, so it cannot ${control}.`,
    workflowRunId: run.id,
    control,
  });
}
