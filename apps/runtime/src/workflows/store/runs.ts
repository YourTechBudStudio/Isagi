import { and, asc, eq, gt, inArray, isNotNull, notInArray } from 'drizzle-orm';

import type { WorkflowRunStatus } from '@isagi/contracts';

import { projects, workflowArtifacts, workflowRuns } from '../../persistence/schema.js';
import { now, type ArtifactRow, type Db, type RunRow } from './rows.js';

/** Runs and the artifact rows they point at. */

export const activeRunStatuses = ['preparing', 'running', 'waiting', 'paused'] as const;
export const finishedRunStatuses = ['completed', 'failed', 'cancelled'] as const;

export function insertArtifact(db: Db, row: Omit<ArtifactRow, 'firstSeenAt'>): void {
  // Content-addressed: the same hash is the same build, and `first_seen_at` means first seen.
  db.insert(workflowArtifacts)
    .values({ ...row, firstSeenAt: now() })
    .onConflictDoNothing({ target: workflowArtifacts.hash })
    .run();
}

export function getArtifact(db: Db, hash: string): ArtifactRow | null {
  return db.select().from(workflowArtifacts).where(eq(workflowArtifacts.hash, hash)).get() ?? null;
}

export function insertRun(
  db: Db,
  row: Omit<RunRow, 'id' | 'createdAt' | 'updatedAt' | 'endedAt' | 'errorJson' | 'outcomeJson'>,
): RunRow {
  const at = now();
  return db
    .insert(workflowRuns)
    .values({ ...row, createdAt: at, updatedAt: at })
    .returning()
    .get();
}

/**
 * Erases every run of a project; invocations, executions, operations, events and checkpoints
 * cascade from `workflow_runs.id`. Must run inside the caller's transaction. Returns the number of
 * runs deleted. The build catalog (`workflow_artifacts`) is not touched.
 */
export function deleteRunsOfProject(db: Db, projectId: number): number {
  return db.delete(workflowRuns).where(eq(workflowRuns.projectId, projectId)).run().changes;
}

/**
 * Whether the project row exists. A read of a workspace-owned table inside the engine's own
 * transaction (ADR 0008 permits cross-domain reads); used only for launch admission.
 */
export function projectExists(db: Db, projectId: number): boolean {
  return (
    db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get() !==
    undefined
  );
}

export function getRun(db: Db, runId: number): RunRow | null {
  return db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get() ?? null;
}

export function updateRun(
  db: Db,
  runId: number,
  patch: Partial<Omit<RunRow, 'id' | 'createdAt' | 'updatedAt'>>,
): RunRow {
  const row = db
    .update(workflowRuns)
    .set({ ...patch, updatedAt: now() })
    .where(eq(workflowRuns.id, runId))
    .returning()
    .get();
  if (!row) throw new Error(`Workflow run ${runId} does not exist.`);
  return row;
}

/** In id order, after `cursor`: the last id the caller received. */
export function listRuns(
  db: Db,
  query: {
    readonly cursor?: number | undefined;
    readonly limit: number;
    readonly workflowKey?: string | undefined;
    readonly status?: WorkflowRunStatus | undefined;
    readonly projectId?: number | undefined;
  },
): readonly RunRow[] {
  return db
    .select()
    .from(workflowRuns)
    .where(
      and(
        query.cursor === undefined ? undefined : gt(workflowRuns.id, query.cursor),
        query.workflowKey === undefined
          ? undefined
          : eq(workflowRuns.workflowKey, query.workflowKey),
        query.status === undefined ? undefined : eq(workflowRuns.status, query.status),
        query.projectId === undefined ? undefined : eq(workflowRuns.projectId, query.projectId),
      ),
    )
    .orderBy(asc(workflowRuns.id))
    .limit(query.limit)
    .all();
}

export function listRunsWithStatus(
  db: Db,
  statuses: readonly WorkflowRunStatus[],
): readonly RunRow[] {
  return db
    .select()
    .from(workflowRuns)
    .where(inArray(workflowRuns.status, [...statuses]))
    .all();
}

/** Every run still attached to a surface, which is what a connecting client is shown. */
export function listAttachedRuns(db: Db): readonly RunRow[] {
  return db.select().from(workflowRuns).where(isNotNull(workflowRuns.surfaceId)).all();
}

/** The run attached to a surface, other than `exceptRunId`. A surface holds at most one. */
export function findRunOnSurface(db: Db, surfaceId: number, exceptRunId?: number): RunRow | null {
  return (
    db
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.surfaceId, surfaceId),
          exceptRunId === undefined ? undefined : notInArray(workflowRuns.id, [exceptRunId]),
        ),
      )
      .get() ?? null
  );
}
