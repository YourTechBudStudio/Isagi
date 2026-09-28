import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { workflowExecutions, workflowGraphInvocations } from '../../persistence/schema.js';
import { now, type Db, type ExecutionRow, type InvocationRow } from './rows.js';

/** Graph invocations and node executions: the run's tree. */

export function insertInvocation(
  db: Db,
  row: Omit<InvocationRow, 'id' | 'startedAt' | 'endedAt' | 'outcomeJson' | 'status'>,
): InvocationRow {
  return db
    .insert(workflowGraphInvocations)
    .values({ ...row, status: 'running', startedAt: now() })
    .returning()
    .get();
}

export function getInvocation(db: Db, invocationId: number): InvocationRow | null {
  return (
    db
      .select()
      .from(workflowGraphInvocations)
      .where(eq(workflowGraphInvocations.id, invocationId))
      .get() ?? null
  );
}

export function updateInvocation(
  db: Db,
  invocationId: number,
  patch: Partial<Omit<InvocationRow, 'id' | 'runId' | 'startedAt'>>,
): void {
  db.update(workflowGraphInvocations)
    .set(patch)
    .where(eq(workflowGraphInvocations.id, invocationId))
    .run();
}

export function listInvocations(db: Db, runId: number): readonly InvocationRow[] {
  return db
    .select()
    .from(workflowGraphInvocations)
    .where(eq(workflowGraphInvocations.runId, runId))
    .orderBy(asc(workflowGraphInvocations.id))
    .all();
}

export function findRootInvocation(db: Db, runId: number): InvocationRow | null {
  return (
    db
      .select()
      .from(workflowGraphInvocations)
      .where(
        and(
          eq(workflowGraphInvocations.runId, runId),
          isNull(workflowGraphInvocations.parentExecutionId),
        ),
      )
      .get() ?? null
  );
}

export function insertExecution(
  db: Db,
  row: Pick<
    ExecutionRow,
    | 'runId'
    | 'invocationId'
    | 'nodeId'
    | 'nodeKind'
    | 'visitIndex'
    | 'label'
    | 'artifactHash'
    | 'retryOf'
  > &
    Partial<Pick<ExecutionRow, 'resultJson' | 'eventJson'>>,
): ExecutionRow {
  return db
    .insert(workflowExecutions)
    .values({ ...row, status: 'running', startedAt: now() })
    .returning()
    .get();
}

export function getExecution(db: Db, executionId: number): ExecutionRow | null {
  return (
    db.select().from(workflowExecutions).where(eq(workflowExecutions.id, executionId)).get() ?? null
  );
}

export function updateExecution(
  db: Db,
  executionId: number,
  patch: Partial<Omit<ExecutionRow, 'id' | 'runId' | 'invocationId' | 'startedAt'>>,
): void {
  db.update(workflowExecutions).set(patch).where(eq(workflowExecutions.id, executionId)).run();
}

export function listExecutions(db: Db, runId: number): readonly ExecutionRow[] {
  return db
    .select()
    .from(workflowExecutions)
    .where(eq(workflowExecutions.runId, runId))
    .orderBy(asc(workflowExecutions.id))
    .all();
}

/**
 * The execution a run is parked on or running: its deepest unfinished one.
 *
 * Sequential execution means there is at most one. A subgraph execution waiting on its child is not
 * the leaf; the child's own execution is.
 */
export function findLeafExecution(db: Db, runId: number): ExecutionRow | null {
  const unfinished = db
    .select()
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.runId, runId),
        inArray(workflowExecutions.status, ['running', 'waiting']),
        isNull(workflowExecutions.childInvocationId),
      ),
    )
    .orderBy(asc(workflowExecutions.id))
    .all();
  return unfinished.at(-1) ?? null;
}

/**
 * The execution a Retry repeats: the most recent failed or interrupted one that has not already
 * been retried.
 */
export function findRetryTarget(db: Db, runId: number): ExecutionRow | null {
  const executions = db
    .select()
    .from(workflowExecutions)
    .where(eq(workflowExecutions.runId, runId))
    .orderBy(asc(workflowExecutions.id))
    .all();
  const retried = new Set(executions.map((execution) => execution.retryOf));
  return (
    executions.findLast(
      (execution) =>
        (execution.status === 'failed' || execution.status === 'interrupted') &&
        !retried.has(execution.id),
    ) ?? null
  );
}

/** How many times a node has been entered in an invocation. Retries repeat a visit, not add one. */
export function countVisits(db: Db, invocationId: number, nodeId: string): number {
  return db
    .select({ id: workflowExecutions.id })
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.invocationId, invocationId),
        eq(workflowExecutions.nodeId, nodeId),
        isNull(workflowExecutions.retryOf),
      ),
    )
    .all().length;
}
