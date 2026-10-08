import { count, eq, inArray } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

import {
  workflowArtifacts,
  workflowCheckpoints,
  workflowEvents,
  workflowExecutions,
  workflowGraphInvocations,
  workflowOperations,
  workflowRuns,
} from '../../persistence/schema.js';
import { insertCheckpoint } from './checkpoints.js';
import { appendEvent } from './events.js';
import { insertOperation } from './operations.js';
import { toJson, type Db } from './rows.js';
import { insertArtifact, insertRun } from './runs.js';
import { insertExecution, insertInvocation } from './tree.js';

/**
 * Seeds runs with one row of every child type, through the store's own writers, so a schema
 * change breaks the seed at compile time instead of drifting from it. Test-only; imports nothing
 * beyond the store.
 */

export const seededArtifactHash = 'seeded-artifact';

export interface RunRowCounts {
  readonly runs: number;
  readonly invocations: number;
  readonly executions: number;
  readonly operations: number;
  readonly events: number;
  readonly checkpoints: number;
  /** Rows of the build catalog for {@link seededArtifactHash}; erasure must not touch it. */
  readonly artifacts: number;
}

/**
 * Seeds `runCount` runs of `projectId`, each with an invocation, an execution, an operation, its
 * `operation_started` event and a checkpoint. `surface_id` is null: it is the run's only foreign
 * key into workspace tables, and the seed must not depend on them.
 */
export function seedProjectRuns(
  db: Db,
  projectId: number,
  options: { readonly runCount?: number } = {},
): { readonly runIds: readonly number[] } {
  insertArtifact(db, {
    hash: seededArtifactHash,
    workflowKey: 'seeded',
    sdkVersion: '0.0.0',
    verifierVersion: '0.0.0',
    contractVersion: 1,
    structureJson: '{}',
  });
  const runIds: number[] = [];
  for (let index = 0; index < (options.runCount ?? 1); index += 1) {
    const run = insertRun(db, {
      projectId,
      workflowKey: 'seeded',
      title: 'Seeded run',
      artifactHash: seededArtifactHash,
      status: 'running',
      inputsJson: '{}',
      parametersJson: 'null',
      placementJson: toJson({ source: 'default', request: { kind: 'current' }, baseCommit: null }),
      originWorktreeId: 0,
      originWorktreePath: '/seeded',
      originSurfaceId: null,
      originPaneId: null,
      originAgentSessionId: null,
      worktreeId: null,
      worktreePath: null,
      setupDone: false,
      surfaceId: null,
    });
    const invocation = insertInvocation(db, {
      runId: run.id,
      parentExecutionId: null,
      graphKey: 'root',
      depth: 0,
      label: null,
      parametersJson: 'null',
      stateJson: '{}',
    });
    const execution = insertExecution(db, {
      runId: run.id,
      invocationId: invocation.id,
      nodeId: 'node',
      nodeKind: 'operation',
      visitIndex: 0,
      label: null,
      artifactHash: seededArtifactHash,
      retryOf: null,
    });
    insertOperation(db, (draft) => appendEvent(db, draft), {
      runId: run.id,
      executionId: execution.id,
      kind: 'run_headless',
      agentSessionId: null,
      paneId: null,
      harness: null,
      model: null,
      effort: null,
      requestJson: '{}',
    });
    insertCheckpoint(db, {
      runId: run.id,
      executionId: execution.id,
      title: 'Checkpoint',
      label: null,
      commitSha: null,
      scopes: [],
    });
    runIds.push(run.id);
  }
  return { runIds };
}

/**
 * Per-table row counts for the given runs. Counts by run id rather than by project, so it still
 * reports what remains after the runs themselves are gone.
 */
export function countRunRows(db: Db, runIds: readonly number[]): RunRowCounts {
  const ids = [...runIds];
  const countWhere = (table: SQLiteTable, runIdColumn: SQLiteColumn): number =>
    ids.length === 0
      ? 0
      : (db.select({ n: count() }).from(table).where(inArray(runIdColumn, ids)).get()?.n ?? 0);
  return {
    runs: countWhere(workflowRuns, workflowRuns.id),
    invocations: countWhere(workflowGraphInvocations, workflowGraphInvocations.runId),
    executions: countWhere(workflowExecutions, workflowExecutions.runId),
    operations: countWhere(workflowOperations, workflowOperations.runId),
    events: countWhere(workflowEvents, workflowEvents.runId),
    checkpoints: countWhere(workflowCheckpoints, workflowCheckpoints.runId),
    artifacts:
      db
        .select({ n: count() })
        .from(workflowArtifacts)
        .where(eq(workflowArtifacts.hash, seededArtifactHash))
        .get()?.n ?? 0,
  };
}
