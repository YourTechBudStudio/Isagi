import { Effect, Result } from 'effect';

import type { DatabaseError } from '../../platform/persistence/index.js';
import { captureCheckpoint } from '../checkpoints/step.js';
import type { WorkflowEngineError } from '../errors.js';
import { makeOperationContext } from '../operations/context.js';
import { isolate } from '../state/isolation.js';
import { checkSerializable, errorMessage } from '../state/pure.js';
import { getOperation, updateOperation } from '../store/operations.js';
import { fromJson, toJson, type ExecutionRow, type RunRow } from '../store/rows.js';
import { getRun, updateRun } from '../store/runs.js';
import { findLeafExecution, getExecution, getInvocation, updateExecution } from '../store/tree.js';
import { nodeOf } from '../structure/graph.js';
import type { LoadedWorkflowArtifact } from '../structure/loader.js';
import type { NodeEvent } from '../types.js';
import { checkWait, type AgentReply, type WaitCheckError } from '../waits/check.js';
import {
  applyChain,
  applyEntry,
  applyFailure,
  computeChain,
  computeEntry,
  subgraphParameters,
  type StepFailure,
} from './chain.js';
import { validateOperationResult, type SavedResult } from './results.js';
import type { EngineRuntime } from './runtime.js';

/**
 * Driving a run: repeat one step until the run is parked.
 *
 * ```text
 * step(execution)
 *   if execution has no saved result
 *     result = run the node function        // the only step with side effects
 *     save result on the execution          // never re-run by accident afterwards
 *   if result is "suspend" and no event yet
 *     park until the wait is delivered
 *   in ONE transaction (all pure): reducers, edge, next execution or the return into the parent
 * ```
 *
 * A run has at most one driver at a time (see `kick`), so its steps are sequential; the node
 * function is the only await that can take long, and it runs outside any transaction. Every step
 * re-reads the run first, so a Pause, Cancel or Resume in the meantime is always respected.
 */
export const driveRun = Effect.fn('workflows.driveRun')(function* (
  rt: EngineRuntime,
  runId: number,
): Effect.fn.Return<void, StepError> {
  for (;;) {
    const parked = yield* step(rt, runId);
    if (parked) return;
  }
});

/**
 * What a step can fail with: the database, an engine refusal inside a commit, or an agent wait's
 * check. Every one is unexpected here, and the run's driver records it as a step failure.
 */
type StepError = WorkflowEngineError | DatabaseError | WaitCheckError;

/** One step. Returns true when there is nothing more to do until something wakes the run. */
const step = Effect.fnUntraced(function* (
  rt: EngineRuntime,
  runId: number,
): Effect.fn.Return<boolean, StepError> {
  const run = yield* rt.read('workflow_read_run', (db) => getRun(db, runId));
  if (!run || (run.status !== 'running' && run.status !== 'waiting')) return true;
  const leaf = yield* rt.read('workflow_read_leaf', (db) => findLeafExecution(db, runId));
  if (!leaf) return true;

  const artifact = yield* rt.loadArtifact(run.artifactHash, run.workflowKey).pipe(Effect.result);
  if (Result.isFailure(artifact)) {
    yield* failStep(rt, run, leaf, {
      stage: 'node_function',
      message: `The build ${run.artifactHash} could not be loaded: ${errorMessage(artifact.failure)}`,
    });
    return true;
  }

  if (leaf.nodeKind === 'subgraph') {
    yield* enterSubgraph(rt, artifact.success, runId, leaf);
    return false;
  }

  const result = fromJson<SavedResult>(leaf.resultJson);
  if (result === null) {
    if (leaf.nodeKind === 'checkpoint') yield* captureCheckpoint(rt, artifact.success, run, leaf);
    else yield* runNodeFunction(rt, artifact.success, run, leaf);
    return false;
  }
  if (result.type === 'complete') {
    return yield* route(rt, artifact.success, runId, leaf.id, { kind: 'immediate' }, null);
  }
  const checked = yield* checkWait(rt, leaf, result.wait);
  rt.freshChecks.delete(runId);
  if (checked.kind === 'waiting') {
    yield* park(rt, runId, leaf.id);
    return true;
  }
  return yield* route(rt, artifact.success, runId, leaf.id, checked.event, checked.reply);
});

/**
 * The pure step for an execution with a saved result: apply its update and route, in one
 * transaction. A stored event (a user's answer) is not announced again; a freshly checked one is.
 */
function route(
  rt: EngineRuntime,
  artifact: LoadedWorkflowArtifact,
  runId: number,
  executionId: number,
  event: NodeEvent,
  reply: AgentReply | null,
): Effect.Effect<boolean, WorkflowEngineError | DatabaseError> {
  return rt.commit('workflow_route', (db, emit) => {
    const run = getRun(db, runId);
    const execution = getExecution(db, executionId);
    // Pause, Cancel or a control may have landed while the wait was being checked.
    if (!run || (run.status !== 'running' && run.status !== 'waiting')) return true;
    if (!execution || (execution.status !== 'running' && execution.status !== 'waiting')) {
      return true;
    }
    if (reply) {
      // The prompt's operation completed when the prompt was sent; the reply is added to it now.
      updateOperation(db, reply.operationId, { responseText: reply.responseText });
      if (reply.unavailable) {
        emit({
          runId,
          executionId,
          category: 'log',
          kind: 'log',
          message: reply.unavailable,
          data: { level: 'warning', message: reply.unavailable },
        });
      }
    }
    const result = fromJson<SavedResult>(execution.resultJson) as SavedResult;
    if (result.type === 'suspend' && execution.eventJson === null) {
      emit({
        runId,
        executionId,
        category: 'node',
        kind: 'wait_delivered',
        message: `${execution.nodeId}: ${describeEvent(event)}`,
        data: event,
      });
    }
    const plan = computeChain(db, artifact, execution, result.update, event);
    if (!plan.ok) {
      applyFailure(db, emit, run, execution, plan.failure, { eventJson: toJson(event) });
      return true;
    }
    applyChain(db, emit, run, plan.value);
    return false;
  });
}

/** Opens a subgraph node's child invocation: `parameters`, `init`, and the child's entry node. */
function enterSubgraph(
  rt: EngineRuntime,
  artifact: LoadedWorkflowArtifact,
  runId: number,
  leaf: ExecutionRow,
) {
  return rt.commit('workflow_enter_subgraph', (db, emit) => {
    const run = getRun(db, runId);
    if (!run || (run.status !== 'running' && run.status !== 'waiting')) return;
    const invocation = getInvocation(db, leaf.invocationId);
    const graph = invocation ? artifact.graphs.get(invocation.graphKey) : undefined;
    const node = graph ? nodeOf(graph, leaf.nodeId) : null;
    const at = { graphKey: invocation?.graphKey ?? '', nodeId: leaf.nodeId };
    if (!invocation || !node || node.isagiKind !== 'subgraph-node') {
      applyFailure(db, emit, run, leaf, {
        stage: 'subgraph_parameters',
        message: `Node '${leaf.nodeId}' is not a subgraph node in this build.`,
        ...at,
      });
      return;
    }
    const child = artifact.graphs.get(node.graph.key);
    if (!child) {
      applyFailure(db, emit, run, leaf, {
        stage: 'graph_init',
        message: `Graph '${node.graph.key}' is not in this build.`,
        graphKey: node.graph.key,
      });
      return;
    }
    const destination = destinationOf(run);
    if (!destination) {
      applyFailure(db, emit, run, leaf, {
        stage: 'graph_init',
        message: `Workflow run ${run.id} has no worktree and surface to work in.`,
        graphKey: child.key,
      });
      return;
    }
    const entry = computeEntry(child, {
      destination,
      depth: invocation.depth + 1,
      parameters: () => subgraphParameters(node, fromJson(invocation.stateJson), at),
    });
    if (!entry.ok) {
      applyFailure(db, emit, run, leaf, entry.failure);
      return;
    }
    applyEntry(db, emit, run, entry.value, leaf);
  });
}

/**
 * Runs an operation node's function and saves what it returned. The one step with side effects,
 * and the one that is never repeated once its result is saved.
 */
const runNodeFunction = Effect.fn('workflows.runNodeFunction')(function* (
  rt: EngineRuntime,
  artifact: LoadedWorkflowArtifact,
  run: RunRow,
  leaf: ExecutionRow,
): Effect.fn.Return<void, WorkflowEngineError | DatabaseError> {
  const invocation = yield* rt.read('workflow_read_invocation', (db) =>
    getInvocation(db, leaf.invocationId),
  );
  const graph = invocation ? artifact.graphs.get(invocation.graphKey) : undefined;
  const node = graph ? nodeOf(graph, leaf.nodeId) : null;
  const at = { graphKey: invocation?.graphKey ?? '', nodeId: leaf.nodeId };
  if (!invocation || !node || node.isagiKind !== 'operation-node') {
    yield* failStep(rt, run, leaf, {
      stage: 'node_function',
      message: `Node '${leaf.nodeId}' is not an operation node in this build.`,
      ...at,
    });
    return;
  }
  const destination = destinationOf(run);
  if (!destination) {
    yield* failStep(rt, run, leaf, {
      stage: 'node_function',
      message: `Workflow run ${run.id} has no worktree and surface to work in.`,
      ...at,
    });
    return;
  }

  // The context closes when the function returns, and also when this step is interrupted.
  const { context, close } = makeOperationContext(rt, run, leaf, destination);
  const returned = yield* rt.bridge
    .call('node function', () => node.run(context, isolate(fromJson(invocation.stateJson))))
    .pipe(Effect.result, Effect.ensuring(Effect.sync(close)));

  yield* rt.commit('workflow_save_result', (db, emit) => {
    const current = getRun(db, run.id);
    const execution = getExecution(db, leaf.id);
    if (!current || !execution) return;
    const failure = (message: string): StepFailure => ({
      stage: 'node_function',
      message,
      ...at,
    });
    if (Result.isFailure(returned)) {
      if (execution.status === 'running' && current.status !== 'cancelled') {
        applyFailure(db, emit, current, execution, failure(returned.failure.message));
      }
      return;
    }
    const validated = validateOperationResult(returned.success);
    const problem = validated.ok
      ? (checkSerializable(validated.value, 'result') ??
        unknownHeadlessHandle(validated.value, (id) => getOperation(db, id), run.id))
      : validated.message;
    if (!validated.ok || problem !== null) {
      if (execution.status === 'running' && current.status !== 'cancelled') {
        applyFailure(db, emit, current, execution, failure(problem ?? 'Invalid result.'));
      }
      return;
    }
    // Saved even when the run was paused or cancelled meanwhile: it is what the function did.
    updateExecution(db, execution.id, { resultJson: toJson(validated.value) });
  });
});

/** Marks the execution and the run as waiting, the first time a check finds nothing yet. */
function park(rt: EngineRuntime, runId: number, executionId: number) {
  return rt.commit('workflow_park', (db, emit) => {
    const run = getRun(db, runId);
    const execution = getExecution(db, executionId);
    if (!run || !execution || (run.status !== 'running' && run.status !== 'waiting')) return;
    if (execution.status === 'running') {
      updateExecution(db, executionId, { status: 'waiting' });
      const result = fromJson<SavedResult>(execution.resultJson);
      emit({
        runId,
        executionId,
        category: 'node',
        kind: 'node_waiting',
        message: `${execution.label ?? execution.nodeId} is waiting`,
        data: result?.type === 'suspend' ? result.wait : null,
      });
    }
    if (run.status === 'running') updateRun(db, runId, { status: 'waiting' });
  });
}

function failStep(rt: EngineRuntime, run: RunRow, leaf: ExecutionRow, failure: StepFailure) {
  return rt.commit('workflow_fail_step', (db, emit) => {
    const current = getRun(db, run.id);
    const execution = getExecution(db, leaf.id);
    if (!current || (current.status !== 'running' && current.status !== 'waiting')) return;
    applyFailure(db, emit, current, execution, failure);
  });
}

export function destinationOf(run: RunRow) {
  if (run.worktreeId === null || run.worktreePath === null || run.surfaceId === null) return null;
  return { worktreeId: run.worktreeId, worktreePath: run.worktreePath, surfaceId: run.surfaceId };
}

/** Every headless handle a wait names must be a headless operation of this run. */
function unknownHeadlessHandle(
  result: SavedResult,
  find: (operationId: number) => { readonly runId: number; readonly kind: string } | null,
  runId: number,
): string | null {
  if (result.type !== 'suspend' || result.wait.kind !== 'headless_agent') return null;
  for (const handle of result.wait.operations) {
    const row = find(Number(handle.operationId));
    if (!row || row.runId !== runId || row.kind !== 'run_headless') {
      return `The wait names operation '${handle.operationId}', which is not a headless run of this workflow run.`;
    }
  }
  return null;
}

function describeEvent(event: NodeEvent): string {
  switch (event.kind) {
    case 'agent_turn':
      return `agent turn ${event.outcome}`;
    case 'headless_agent':
      return `${event.results.length} headless result(s)`;
    default:
      return event.kind.replace('_', ' ');
  }
}
