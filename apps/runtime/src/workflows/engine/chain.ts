import type { WorkflowErrorStage, WorkflowNodeKind } from '@isagi/contracts';

import { isolate } from '../state/isolation.js';
import { captureLabel } from '../state/labels.js';
import { evaluatePure } from '../state/pure.js';
import { assertDeclaredStateFields, isPlainObject, reduceState } from '../state/reducers.js';
import {
  fromJson,
  now,
  toJson,
  type Db,
  type ExecutionRow,
  type InvocationRow,
  type Outcome,
  type RunError,
  type RunRow,
} from '../store/rows.js';
import { updateRun } from '../store/runs.js';
import {
  countVisits,
  getExecution,
  getInvocation,
  insertExecution,
  insertInvocation,
  updateExecution,
  updateInvocation,
} from '../store/tree.js';
import {
  destinationKindOf,
  edgeFromNode,
  nodeKindOf,
  nodeOf,
  outcomeOf,
  type AnyGraphNode,
} from '../structure/graph.js';
import type { AnyGraphDefinition, LoadedWorkflowArtifact } from '../structure/loader.js';
import type { NodeEvent, SubgraphResult, WorkflowDestination } from '../types.js';
import type { Emit } from './runtime.js';

/**
 * The pure step: everything that happens after a node function's result is saved.
 *
 * Each function here first *computes* in memory — reducers, the edge, an outcome's output, a
 * parent's `onResult`, reducers and edge, all the way up — and then *applies* the result in one
 * write. Nothing is written while author code runs, so a throw anywhere leaves every invocation's
 * state unchanged. The failure is recorded on the execution being stepped, with the stage and the
 * graph and node (or outcome) whose code threw, and a Retry replays the whole chain with the
 * current code.
 *
 * All author code here always runs from the current build: only the node function's result is ever
 * reused.
 */

export interface StepFailure extends RunError {}

type Computed<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly failure: StepFailure };

function failed(
  stage: WorkflowErrorStage,
  message: string,
  at: { readonly graphKey?: string | undefined; readonly nodeId?: string | undefined } = {},
): { readonly ok: false; readonly failure: StepFailure } {
  return {
    ok: false,
    failure: {
      stage,
      message,
      ...(at.graphKey === undefined ? {} : { graphKey: at.graphKey }),
      ...(at.nodeId === undefined ? {} : { nodeId: at.nodeId }),
    },
  };
}

/** A new execution the step creates: the next node visit, or a subgraph's entry node. */
interface NewExecution {
  readonly invocationId: number;
  readonly nodeId: string;
  readonly nodeKind: WorkflowNodeKind;
  readonly visitIndex: number;
  readonly label: string | null;
}

// --- routing an execution ------------------------------------------------------------------------

export interface ChainPlan {
  /** Root last: the stepped execution, then each parent a finished child returned into. */
  readonly completed: readonly {
    readonly execution: ExecutionRow;
    readonly event: NodeEvent;
    readonly decision: { readonly to: string; readonly update?: unknown };
    readonly stateAfter: Record<string, unknown>;
  }[];
  readonly finished: readonly { readonly invocation: InvocationRow; readonly outcome: Outcome }[];
  readonly next:
    | ({ readonly kind: 'execution' } & NewExecution)
    | { readonly kind: 'run_completed'; readonly outcome: Outcome };
}

/**
 * Applies the stepped execution's update, runs its edge, and follows the decision: to the next node,
 * or through the graph's outcome back into the parent, whose `onResult`, reducers and edge run the
 * same way.
 */
export function computeChain(
  db: Db,
  artifact: LoadedWorkflowArtifact,
  stepped: ExecutionRow,
  update: unknown,
  event: NodeEvent,
): Computed<ChainPlan> {
  const completed: ChainPlan['completed'][number][] = [];
  const finished: ChainPlan['finished'][number][] = [];
  let current = { execution: stepped, update, event };

  for (;;) {
    const invocation = requireRow(getInvocation(db, current.execution.invocationId), 'invocation');
    const graph = artifact.graphs.get(invocation.graphKey);
    const at = { graphKey: invocation.graphKey, nodeId: current.execution.nodeId };
    if (!graph) return failed('edge', `Graph '${invocation.graphKey}' is not in this build.`, at);
    const fields = graph.state as Parameters<typeof reduceState>[0]['fields'];

    const updated = reduceState({
      fields,
      current: fromJson<Record<string, unknown>>(invocation.stateJson),
      update: current.update,
      graphKey: invocation.graphKey,
    });
    if (!updated.ok) return failed('reducer', updated.message, at);

    const router = edgeFromNode(graph, current.execution.nodeId);
    if (!router) {
      return failed('edge', `No edge leaves node '${current.execution.nodeId}'.`, at);
    }
    const chosen = evaluatePure({
      what: `Edge '${router.id}'`,
      run: () => router.edge.choose(isolate(updated.state), isolate(current.event)),
      serializeAs: 'decision',
    });
    if (!chosen.ok) return failed('edge', chosen.message, at);
    const decision = chosen.value as unknown;
    if (!isPlainObject(decision) || typeof decision.to !== 'string') {
      return failed('edge', `Edge '${router.id}' must return { to }.`, at);
    }
    const to = decision.to;
    const destination = destinationKindOf(graph, to);
    if (!router.edge.to.includes(to) || destination === null) {
      return failed(
        'edge',
        `Edge '${router.id}' routed to '${to}', which is not one of its declared destinations.`,
        at,
      );
    }
    const routed = reduceState({
      fields,
      current: updated.state,
      update: decision.update,
      graphKey: invocation.graphKey,
    });
    if (!routed.ok) return failed('reducer', `Edge '${router.id}' update: ${routed.message}`, at);
    const state = routed.state;
    completed.push({
      execution: current.execution,
      event: current.event,
      decision: decision.update === undefined ? { to } : { to, update: decision.update },
      stateAfter: state,
    });

    if (destination === 'node') {
      const node = nodeOf(graph, to) as AnyGraphNode;
      return {
        ok: true,
        value: {
          completed,
          finished,
          next: {
            kind: 'execution',
            invocationId: invocation.id,
            nodeId: to,
            nodeKind: nodeKindOf(node),
            visitIndex: countVisits(db, invocation.id, to),
            label: nodeLabel(node, state),
          },
        },
      };
    }

    const declared = outcomeOf(graph, to);
    if (!declared) return failed('graph_output', `Outcome '${to}' is not declared.`, at);
    const output = evaluatePure({
      what: `Outcome '${to}' output`,
      run: () => declared.output(isolate(state)),
      serializeAs: 'output',
    });
    if (!output.ok) {
      return failed('graph_output', output.message, { graphKey: invocation.graphKey, nodeId: to });
    }
    const outcome: Outcome = {
      outcomeId: to,
      kind: declared.kind,
      reason: declared.reason ?? null,
      output: output.value,
    };
    finished.push({ invocation, outcome });
    if (invocation.parentExecutionId === null) {
      return { ok: true, value: { completed, finished, next: { kind: 'run_completed', outcome } } };
    }

    // The finished child's outcome is data for the parent: its `onResult`, reducers and edge run
    // next, in this same step.
    const parent = requireRow(getExecution(db, invocation.parentExecutionId), 'execution');
    const parentInvocation = requireRow(getInvocation(db, parent.invocationId), 'invocation');
    const parentAt = { graphKey: parentInvocation.graphKey, nodeId: parent.nodeId };
    const parentGraph = artifact.graphs.get(parentInvocation.graphKey);
    const subgraph = parentGraph ? nodeOf(parentGraph, parent.nodeId) : null;
    if (!subgraph || subgraph.isagiKind !== 'subgraph-node') {
      return failed(
        'subgraph_on_result',
        `Node '${parent.nodeId}' in graph '${parentInvocation.graphKey}' is no longer a subgraph node.`,
        parentAt,
      );
    }
    const result: SubgraphResult<unknown> = {
      outcomeId: outcome.outcomeId as SubgraphResult<unknown>['outcomeId'],
      outcomeKind: outcome.kind,
      ...(outcome.reason === null ? {} : { reason: outcome.reason }),
      output: outcome.output,
    };
    const mapped = evaluatePure({
      what: `Subgraph '${parent.nodeId}' onResult`,
      run: () =>
        subgraph.onResult(
          isolate(fromJson<Record<string, unknown>>(parentInvocation.stateJson)),
          isolate(result),
        ),
    });
    if (!mapped.ok) return failed('subgraph_on_result', mapped.message, parentAt);
    current = { execution: parent, update: mapped.value, event: { kind: 'subgraph', result } };
  }
}

export function applyChain(db: Db, emit: Emit, run: RunRow, plan: ChainPlan): void {
  const endedAt = now();
  for (const step of plan.completed) {
    updateExecution(db, step.execution.id, {
      status: 'completed',
      eventJson: toJson(step.event),
      decisionJson: toJson(step.decision),
      stateAfterJson: toJson(step.stateAfter),
      endedAt,
    });
    updateInvocation(db, step.execution.invocationId, { stateJson: toJson(step.stateAfter) });
    emit({
      runId: run.id,
      executionId: step.execution.id,
      category: 'node',
      kind: 'node_completed',
      message: `${step.execution.nodeId} → ${step.decision.to}`,
      data: { to: step.decision.to },
    });
  }
  for (const done of plan.finished) {
    updateInvocation(db, done.invocation.id, {
      status: 'completed',
      outcomeJson: toJson(done.outcome),
      endedAt,
    });
    emit({
      runId: run.id,
      executionId: done.invocation.parentExecutionId,
      category: 'node',
      kind: 'graph_completed',
      message: `${done.invocation.graphKey} finished with ${done.outcome.outcomeId} (${done.outcome.kind})`,
      data: { invocationId: done.invocation.id, outcome: done.outcome },
    });
  }
  if (plan.next.kind === 'run_completed') {
    updateRun(db, run.id, {
      status: 'completed',
      outcomeJson: toJson(plan.next.outcome),
      errorJson: null,
      endedAt,
    });
    emit({
      runId: run.id,
      category: 'run',
      kind: 'run_completed',
      message: `Finished with ${plan.next.outcome.outcomeId} (${plan.next.outcome.kind})`,
      data: { outcome: plan.next.outcome },
    });
    return;
  }
  startExecution(db, emit, run, plan.next);
  if (run.status === 'waiting') updateRun(db, run.id, { status: 'running' });
}

// --- entering a graph ----------------------------------------------------------------------------

export interface EntryPlan {
  readonly graphKey: string;
  readonly depth: number;
  readonly label: string | null;
  readonly parameters: unknown;
  readonly state: Record<string, unknown>;
  readonly entry: Omit<NewExecution, 'invocationId'>;
}

/** `parameters` (for a subgraph), then the graph's `init`, then its entry node's label. */
export function computeEntry(
  graph: AnyGraphDefinition,
  input: {
    readonly destination: WorkflowDestination;
    readonly depth: number;
    readonly parameters: () => Computed<unknown>;
  },
): Computed<EntryPlan> {
  const parameters = input.parameters();
  if (!parameters.ok) return parameters;
  const initialized = evaluatePure({
    what: `Graph '${graph.key}' init`,
    run: () => graph.init(isolate(input.destination), isolate(parameters.value)),
    serializeAs: 'state',
  });
  if (!initialized.ok) return failed('graph_init', initialized.message, { graphKey: graph.key });
  const undeclared = assertDeclaredStateFields({
    fields: graph.state as Parameters<typeof assertDeclaredStateFields>[0]['fields'],
    state: initialized.value,
    graphKey: graph.key,
  });
  if (undeclared) return failed('graph_init', undeclared, { graphKey: graph.key });
  const state = initialized.value as Record<string, unknown>;
  const entry = nodeOf(graph, graph.entry);
  if (!entry) {
    return failed('graph_init', `Entry node '${graph.entry}' is not declared.`, {
      graphKey: graph.key,
    });
  }
  return {
    ok: true,
    value: {
      graphKey: graph.key,
      depth: input.depth,
      label: captureLabel(
        graph.label as ((argument: never) => unknown) | undefined,
        parameters.value,
      ),
      parameters: parameters.value,
      state,
      entry: {
        nodeId: graph.entry,
        nodeKind: nodeKindOf(entry),
        visitIndex: 0,
        label: nodeLabel(entry, state),
      },
    },
  };
}

/** The subgraph node's `parameters`, evaluated against the parent invocation's current state. */
export function subgraphParameters(
  node: AnyGraphNode,
  parentState: unknown,
  at: { readonly graphKey: string; readonly nodeId: string },
): Computed<unknown> {
  if (node.isagiKind !== 'subgraph-node') {
    return failed('subgraph_parameters', `Node '${at.nodeId}' is not a subgraph node.`, at);
  }
  // A child graph without parameters is handed `undefined`, which is stored as JSON null.
  const parameters = evaluatePure({
    what: `Subgraph '${at.nodeId}' parameters`,
    run: () => node.parameters(isolate(parentState)) ?? null,
    serializeAs: 'parameters',
  });
  if (!parameters.ok) return failed('subgraph_parameters', parameters.message, at);
  return { ok: true, value: parameters.value === null ? undefined : parameters.value };
}

/** Opens a graph invocation and its entry execution. `parent` is null for the root graph. */
export function applyEntry(
  db: Db,
  emit: Emit,
  run: RunRow,
  plan: EntryPlan,
  parent: ExecutionRow | null,
): void {
  const invocation = insertInvocation(db, {
    runId: run.id,
    parentExecutionId: parent?.id ?? null,
    graphKey: plan.graphKey,
    depth: plan.depth,
    label: plan.label,
    parametersJson: toJson(plan.parameters ?? null),
    stateJson: toJson(plan.state),
  });
  if (parent) {
    updateExecution(db, parent.id, { status: 'waiting', childInvocationId: invocation.id });
  }
  emit({
    runId: run.id,
    executionId: parent?.id ?? null,
    category: 'node',
    kind: 'graph_entered',
    message: `Entered ${plan.label ?? plan.graphKey}`,
    data: { invocationId: invocation.id, graphKey: plan.graphKey },
  });
  startExecution(db, emit, run, { ...plan.entry, invocationId: invocation.id });
}

function startExecution(db: Db, emit: Emit, run: RunRow, next: NewExecution): void {
  const execution = insertExecution(db, {
    runId: run.id,
    invocationId: next.invocationId,
    nodeId: next.nodeId,
    nodeKind: next.nodeKind,
    visitIndex: next.visitIndex,
    label: next.label,
    artifactHash: run.artifactHash,
    retryOf: null,
  });
  emit({
    runId: run.id,
    executionId: execution.id,
    category: 'node',
    kind: 'node_started',
    message: `Started ${next.label ?? next.nodeId}`,
    data: { nodeId: next.nodeId, nodeKind: next.nodeKind },
  });
}

/** Records a failed step: the stepped execution and the run fail, and nothing else changes. */
export function applyFailure(
  db: Db,
  emit: Emit,
  run: RunRow,
  execution: ExecutionRow | null,
  failure: StepFailure,
  extra: { readonly eventJson?: string | null; readonly status?: 'failed' | 'interrupted' } = {},
): void {
  const endedAt = now();
  if (execution) {
    updateExecution(db, execution.id, {
      status: extra.status ?? 'failed',
      errorJson: toJson(failure),
      ...(extra.eventJson === undefined ? {} : { eventJson: extra.eventJson }),
      endedAt,
    });
    emit({
      runId: run.id,
      executionId: execution.id,
      category: 'node',
      kind: extra.status === 'interrupted' ? 'node_interrupted' : 'node_failed',
      message: failure.message,
      data: failure,
    });
  }
  updateRun(db, run.id, { status: 'failed', errorJson: toJson(failure), endedAt });
  emit({
    runId: run.id,
    executionId: execution?.id ?? null,
    category: 'run',
    kind: 'run_failed',
    message: failure.message,
    data: failure,
  });
}

function nodeLabel(node: AnyGraphNode, state: unknown): string | null {
  return captureLabel(node.label as ((argument: never) => unknown) | undefined, state);
}

function requireRow<A>(row: A | null, what: string): A {
  if (row === null) throw new Error(`A workflow ${what} this step depends on is missing.`);
  return row;
}
