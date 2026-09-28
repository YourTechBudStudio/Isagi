import type {
  GetWorkflowRunOutput,
  WorkflowEventDto,
  WorkflowExecutionSummaryDto,
  WorkflowGraphInvocationDto,
  WorkflowRunSummary,
} from '@isagi/contracts';

/**
 * One run as the inspector reads it: the run detail's tree, indexed, plus its event log.
 *
 * Both halves come straight from the runtime's routes. Nothing here is merged or reconciled; a new
 * event or a refetched detail simply produces a new view.
 */
export interface WorkflowRunView {
  readonly runId: number;
  readonly run: WorkflowRunSummary;
  readonly inputs: GetWorkflowRunOutput['inputs'];
  readonly invocations: ReadonlyMap<number, WorkflowGraphInvocationDto>;
  /** The root graph's invocation. Null while the run is still being prepared. */
  readonly rootInvocationId: number | null;
  readonly executions: ReadonlyMap<number, WorkflowExecutionSummaryDto>;
  /** Execution ids in `(startedAt, executionId)` order. */
  readonly executionOrder: readonly number[];
  readonly events: readonly WorkflowEventDto[];
  /** False until the whole event log has been read once. */
  readonly eventsLoaded: boolean;
}

export function buildRunView(
  detail: GetWorkflowRunOutput,
  events: readonly WorkflowEventDto[] | undefined,
): WorkflowRunView {
  const invocations = new Map(detail.invocations.map((row) => [row.invocationId, row]));
  const executions = new Map(detail.executions.map((row) => [row.executionId, row]));
  const executionOrder = [...detail.executions]
    .sort((left, right) =>
      left.startedAt === right.startedAt
        ? left.executionId - right.executionId
        : left.startedAt < right.startedAt
          ? -1
          : 1,
    )
    .map((row) => row.executionId);
  const root = detail.invocations.find((row) => row.parentExecutionId === null) ?? null;
  return {
    runId: detail.run.runId,
    run: detail.run,
    inputs: detail.inputs,
    invocations,
    rootInvocationId: root?.invocationId ?? null,
    executions,
    executionOrder,
    events: events ?? [],
    eventsLoaded: events !== undefined,
  };
}

export function orderedExecutions(view: WorkflowRunView): readonly WorkflowExecutionSummaryDto[] {
  const rows: WorkflowExecutionSummaryDto[] = [];
  for (const id of view.executionOrder) {
    const execution = view.executions.get(id);
    if (execution) rows.push(execution);
  }
  return rows;
}

/** The subgraph execution that entered an invocation, or undefined for the root. */
export function invocationOpener(
  view: WorkflowRunView,
  invocationId: number,
): WorkflowExecutionSummaryDto | undefined {
  const parent = view.invocations.get(invocationId)?.parentExecutionId ?? null;
  return parent === null ? undefined : view.executions.get(parent);
}
