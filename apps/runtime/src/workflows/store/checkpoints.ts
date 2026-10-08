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
    /** The node's static title, else its id. */
    readonly title: string;
    /** The execution's captured label. */
    readonly label: string | null;
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
      label: row.label,
      commitSha: row.commitSha,
      scopesJson: toJson(row.scopes),
      createdAt: now(),
    })
    .returning()
    .get();
}

/**
 * Every content hash any checkpoint references: the content collector's mark. One JSON scan of
 * `workflow_checkpoints`; a missing scope has no files and contributes nothing.
 */
export function listReferencedContentHashes(db: Db): Set<string> {
  const rows = db.all<{ readonly sha256: string | null }>(
    sql`select distinct json_extract(file.value, '$.sha256') as sha256
        from ${workflowCheckpoints},
             json_each(${workflowCheckpoints.scopesJson}) as scope,
             json_each(scope.value, '$.files') as file`,
  );
  const hashes = new Set<string>();
  for (const row of rows) if (typeof row.sha256 === 'string') hashes.add(row.sha256);
  return hashes;
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
