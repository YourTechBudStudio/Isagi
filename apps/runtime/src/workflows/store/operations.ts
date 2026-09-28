import { and, asc, eq, gt, max } from 'drizzle-orm';

import type { WorkflowOperationStatus } from '@isagi/contracts';

import { workflowOperations } from '../../persistence/schema.js';
import type { EventDraft } from './events.js';
import { now, type Db, type OperationRow } from './rows.js';

/**
 * The operation log: one row per side-effecting `ctx` call. History only, never consulted to skip
 * work.
 *
 * Starting and settling an operation each append their event (`operation_started`,
 * `operation_finished`) in the same write, which is why both take the transaction's `emit`.
 */

const operationLabels: Record<OperationRow['kind'], string> = {
  spawn_agent: 'Spawn an agent',
  send_prompt: 'Send a prompt',
  run_headless: 'Headless job',
  close_pane: 'Close a pane',
};

export function insertOperation(
  db: Db,
  emit: (draft: EventDraft) => void,
  row: Pick<
    OperationRow,
    'runId' | 'executionId' | 'kind' | 'agentSessionId' | 'paneId' | 'harness' | 'model' | 'effort'
  > & { readonly requestJson: string },
): OperationRow {
  const previous = db
    .select({ seq: max(workflowOperations.seq) })
    .from(workflowOperations)
    .where(eq(workflowOperations.executionId, row.executionId))
    .get();
  const seq = previous?.seq === null || previous?.seq === undefined ? 0 : previous.seq + 1;
  const operation = db
    .insert(workflowOperations)
    .values({ ...row, seq, status: 'running', startedAt: now() })
    .returning()
    .get();
  emit({
    runId: operation.runId,
    executionId: operation.executionId,
    category: 'node',
    kind: 'operation_started',
    message: `${operationLabels[operation.kind]} started`,
    data: { operationId: operation.id, kind: operation.kind },
  });
  return operation;
}

export function updateOperation(
  db: Db,
  operationId: number,
  patch: Partial<Omit<OperationRow, 'id' | 'runId' | 'executionId' | 'seq' | 'kind' | 'startedAt'>>,
): void {
  db.update(workflowOperations).set(patch).where(eq(workflowOperations.id, operationId)).run();
}

/** Ends an operation with its final status. */
export function settleOperation(
  db: Db,
  emit: (draft: EventDraft) => void,
  operationId: number,
  status: Exclude<WorkflowOperationStatus, 'running'>,
  patch: Partial<
    Pick<OperationRow, 'responseText' | 'resultJson' | 'harnessSessionId' | 'usageJson'>
  >,
): void {
  const operation = db
    .update(workflowOperations)
    .set({ ...patch, status, endedAt: now() })
    .where(eq(workflowOperations.id, operationId))
    .returning()
    .get();
  if (!operation) return;
  emit({
    runId: operation.runId,
    executionId: operation.executionId,
    category: 'node',
    kind: 'operation_finished',
    message: `${operationLabels[operation.kind]} ${status}`,
    data: { operationId: operation.id, kind: operation.kind, status },
  });
}

export function getOperation(db: Db, operationId: number): OperationRow | null {
  return (
    db.select().from(workflowOperations).where(eq(workflowOperations.id, operationId)).get() ?? null
  );
}

export function listOperations(
  db: Db,
  query: {
    readonly runId?: number | undefined;
    readonly executionId?: number | undefined;
    readonly agentSessionId?: number | undefined;
    readonly status?: WorkflowOperationStatus | undefined;
    readonly cursor?: number | undefined;
    readonly limit?: number | undefined;
  },
): readonly OperationRow[] {
  const select = db
    .select()
    .from(workflowOperations)
    .where(
      and(
        query.runId === undefined ? undefined : eq(workflowOperations.runId, query.runId),
        query.executionId === undefined
          ? undefined
          : eq(workflowOperations.executionId, query.executionId),
        query.agentSessionId === undefined
          ? undefined
          : eq(workflowOperations.agentSessionId, query.agentSessionId),
        query.status === undefined ? undefined : eq(workflowOperations.status, query.status),
        query.cursor === undefined ? undefined : gt(workflowOperations.id, query.cursor),
      ),
    )
    .orderBy(asc(workflowOperations.id));
  return query.limit === undefined ? select.all() : select.limit(query.limit).all();
}
