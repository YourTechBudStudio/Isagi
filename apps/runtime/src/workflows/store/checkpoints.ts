import { and, asc, eq, gt, sql } from 'drizzle-orm';

import type { WorkflowCheckpointScopeDto } from '@isagi/contracts';

import { workflowCheckpoints } from '../../persistence/schema.js';
import { now, toJson, type CheckpointRow, type Db } from './rows.js';

/**
 * Checkpoint rows: the commit plus an exact copy of the scopes a plan named. `scopes_json` holds the
 * wire's scope shape, file lists included; the bytes live in the content store.
 */

export type CheckpointScope = WorkflowCheckpointScopeDto;

export function insertCheckpoint(
  db: Db,
  row: {
    readonly runId: number;
    readonly executionId: number;
    readonly title: string;
    readonly commitSha: string | null;
    readonly scopes: readonly CheckpointScope[];
  },
): CheckpointRow {
  return db
    .insert(workflowCheckpoints)
    .values({
      runId: row.runId,
      executionId: row.executionId,
      title: row.title,
      commitSha: row.commitSha,
      scopesJson: toJson(row.scopes),
      createdAt: now(),
    })
    .returning()
    .get();
}

export function getCheckpoint(db: Db, checkpointId: number): CheckpointRow | null {
  return (
    db.select().from(workflowCheckpoints).where(eq(workflowCheckpoints.id, checkpointId)).get() ??
    null
  );
}

export function listCheckpoints(
  db: Db,
  query: {
    readonly runId: number;
    readonly executionId?: number | undefined;
    /** Only checkpoints that captured a scope with this name. */
    readonly scope?: string | undefined;
    readonly cursor?: number | undefined;
    readonly limit: number;
  },
): readonly CheckpointRow[] {
  return db
    .select()
    .from(workflowCheckpoints)
    .where(
      and(
        eq(workflowCheckpoints.runId, query.runId),
        query.executionId === undefined
          ? undefined
          : eq(workflowCheckpoints.executionId, query.executionId),
        query.scope === undefined
          ? undefined
          : sql`exists (select 1 from json_each(${workflowCheckpoints.scopesJson}) where json_extract(value, '$.scope') = ${query.scope})`,
        query.cursor === undefined ? undefined : gt(workflowCheckpoints.id, query.cursor),
      ),
    )
    .orderBy(asc(workflowCheckpoints.id))
    .limit(query.limit)
    .all();
}
