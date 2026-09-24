import { and, asc, eq, gt, gte, inArray, lte, ne, or, sql } from 'drizzle-orm';

import {
  apiBasePath,
  type WorkflowCheckpointDto,
  type WorkflowCheckpointInventoryEntry,
  type WorkflowCheckpointManifestEntry,
  type WorkflowCheckpointSummaryDto,
  type WorkflowExecutionCheckpointDto,
} from '@isagi/contracts';

import type { RuntimeDrizzleDatabase } from '../../../persistence/database.service.js';
import { workflowCheckpointEntries, workflowCheckpoints } from '../../../persistence/schema.js';
import type {
  WorkflowCheckpointEntryRecord,
  WorkflowCheckpointRecord,
} from '../../persistence/records.js';
import { checkpointEntryRecord, checkpointRecord } from '../../persistence/row-mappers.js';

/**
 * Projecting saved checkpoints.
 *
 * Every read here serves rows the capture already materialized: a checkpoint's final inventory is
 * stored with it, so nothing replays ancestors, runs Git or looks at the filesystem. Rows are
 * decoded through the same mappers the capture fold uses, so a read and a later capture can never
 * disagree about what a row means.
 *
 * Nothing here claims saved bytes or the base commit are still available. Bytes are learned at
 * content fetch; the commit is learned by whatever later tries to check it out.
 */

type EntryRow = typeof workflowCheckpointEntries.$inferSelect;

/** A checkpoint with its parent's public key, which is all a detail or layer needs beyond itself. */
export interface CheckpointWithParent {
  readonly checkpoint: WorkflowCheckpointRecord;
  readonly parentKey: string | null;
}

/**
 * The parent's public key, as a correlated lookup on the primary key rather than a self-join, so the
 * selection stays one whole-table row that the shared mapper decodes.
 *
 * The outer column is spelled out with its table: drizzle renders a single-table column unqualified,
 * which inside this subquery would bind to the parent row's own `parent_checkpoint_id`.
 */
function parentKeyOf() {
  return sql<
    string | null
  >`(SELECT p.checkpoint_key FROM workflow_checkpoints p WHERE p.id = "workflow_checkpoints"."parent_checkpoint_id")`;
}

/**
 * One checkpoint by public key, scoped to its run.
 *
 * Run-scoped deliberately, like evidence: a key another run saved is not one this run can serve, and
 * a miss must not distinguish "never existed" from "belongs to somebody else".
 */
export function checkpointInRun(
  db: RuntimeDrizzleDatabase,
  runId: number,
  checkpointKey: string,
): CheckpointWithParent | null {
  const row = db
    .select({ checkpoint: workflowCheckpoints, parentKey: parentKeyOf() })
    .from(workflowCheckpoints)
    .where(
      and(
        eq(workflowCheckpoints.runId, runId),
        eq(workflowCheckpoints.checkpointKey, checkpointKey),
      ),
    )
    .get();
  return row ? { checkpoint: checkpointRecord(row.checkpoint), parentKey: row.parentKey } : null;
}

/** The checkpoint one visit committed, through the unique execution index. */
export function checkpointOfExecution(
  db: RuntimeDrizzleDatabase,
  executionId: number,
): WorkflowExecutionCheckpointDto | null {
  const row = db
    .select()
    .from(workflowCheckpoints)
    .where(eq(workflowCheckpoints.executionId, executionId))
    .get();
  if (!row) return null;
  const checkpoint = checkpointRecord(row);
  return {
    checkpointId: checkpoint.checkpointKey,
    title: checkpoint.title,
    base: checkpoint.base,
    counts: checkpoint.counts,
  };
}

export function checkpointSummaryDto(
  checkpoint: WorkflowCheckpointRecord,
): WorkflowCheckpointSummaryDto {
  return {
    checkpointId: checkpoint.checkpointKey,
    runId: checkpoint.runId,
    frameId: checkpoint.frameId,
    executionId: checkpoint.executionId,
    attemptId: checkpoint.attemptId,
    nodeId: checkpoint.nodeId,
    title: checkpoint.title,
    createdAt: checkpoint.createdAt,
    base: checkpoint.base,
  };
}

export function checkpointDto({
  checkpoint,
  parentKey,
}: CheckpointWithParent): WorkflowCheckpointDto {
  const self = `${apiBasePath}/workflows/runs/${checkpoint.runId}/checkpoints/${checkpoint.checkpointKey}`;
  return {
    ...checkpointSummaryDto(checkpoint),
    parentCheckpointId: parentKey,
    artifactHash: checkpoint.artifactHash,
    provenance: { repositoryRootPath: checkpoint.repositoryRootPath },
    counts: checkpoint.counts,
    // Summarized when the checkpoint committed, so this read never walks its warning rows.
    warningGroups: checkpoint.warningGroups,
    links: { inventory: `${self}/inventory`, manifest: `${self}/manifest` },
  };
}

/** The bare hex digest, so a client can verify bytes without learning the store's naming. */
function sha256Of(contentRef: string): string {
  return contentRef.slice('sha256:'.length);
}

export function inventoryEntryDto(
  entry: WorkflowCheckpointEntryRecord,
): WorkflowCheckpointInventoryEntry {
  switch (entry.kind) {
    case 'scope':
      return {
        kind: 'scope',
        scopeId: entry.scopeId,
        scopeKind: entry.scopeKind,
        path: entry.path,
        exclusions: entry.exclusions,
        capturedBy: entry.capturedBy,
      };
    case 'file':
      return {
        kind: 'file',
        path: entry.path,
        fileId: entry.fileKey,
        sha256: sha256Of(entry.contentRef),
        sizeBytes: entry.byteSize,
        executable: entry.executable,
      };
    case 'absent':
      return { kind: 'absent', path: entry.path };
    case 'warning':
      return {
        kind: 'warning',
        reason: entry.reason,
        path: entry.path,
        scopeId: entry.scopeId,
        detail: entry.detail,
        observedBy: entry.observedBy,
      };
    case 'change':
      // The inventory query never selects change rows; reaching here is a query defect.
      throw new Error(`Checkpoint change row ${entry.seq} is not an inventory entry.`);
  }
}

export function layerEntryDto({
  checkpoint,
  parentKey,
}: CheckpointWithParent): WorkflowCheckpointManifestEntry {
  return {
    kind: 'layer',
    checkpointId: checkpoint.checkpointKey,
    parentCheckpointId: parentKey,
    title: checkpoint.title,
    createdAt: checkpoint.createdAt,
    base: checkpoint.base,
  };
}

export function manifestEntryDto(
  entry: WorkflowCheckpointEntryRecord,
  checkpointKey: string,
): WorkflowCheckpointManifestEntry {
  switch (entry.kind) {
    case 'scope':
      return {
        kind: 'scope',
        checkpointId: checkpointKey,
        scopeId: entry.scopeId,
        scopeKind: entry.scopeKind,
        path: entry.path,
        exclusions: entry.exclusions,
      };
    case 'change':
      return {
        kind: 'change',
        checkpointId: checkpointKey,
        operation: entry.operation,
        path: entry.path,
        ...(entry.contentRef === null ? {} : { sha256: sha256Of(entry.contentRef) }),
        ...(entry.byteSize === null ? {} : { sizeBytes: entry.byteSize }),
        ...(entry.executable === null ? {} : { executable: entry.executable }),
      };
    case 'warning':
      return {
        kind: 'warning',
        checkpointId: checkpointKey,
        reason: entry.reason,
        path: entry.path,
        scopeId: entry.scopeId,
        detail: entry.detail,
      };
    case 'file':
    case 'absent':
      // The manifest query never selects resolved-state rows; reaching here is a query defect.
      throw new Error(`Checkpoint ${entry.kind} row ${entry.seq} is not a manifest entry.`);
  }
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/**
 * One page of a checkpoint's final state, in stored `seq` order.
 *
 * Every kind but `change` is resolved state, and `seq` places changes last, so the unique
 * `(checkpoint_id, seq)` index serves both the filter and the order.
 */
export function inventoryPage(
  db: RuntimeDrizzleDatabase,
  input: {
    readonly checkpointRowId: number;
    readonly afterSeq: number | null;
    readonly take: number;
  },
): readonly { readonly seq: number; readonly entry: WorkflowCheckpointInventoryEntry }[] {
  return db
    .select()
    .from(workflowCheckpointEntries)
    .where(
      and(
        eq(workflowCheckpointEntries.checkpointId, input.checkpointRowId),
        ne(workflowCheckpointEntries.kind, 'change'),
        ...(input.afterSeq === null ? [] : [gt(workflowCheckpointEntries.seq, input.afterSeq)]),
      ),
    )
    .orderBy(asc(workflowCheckpointEntries.seq))
    .limit(input.take)
    .all()
    .map((row) => ({ seq: row.seq, entry: inventoryEntryDto(checkpointEntryRecord(row)) }));
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/** A layer item sorts before every stored row of its checkpoint, whose `seq` starts at 0. */
export const layerOrdinal = -1;

export interface ManifestItem {
  /** `[checkpoint row id, ordinal]`, the listing's cursor key. */
  readonly key: readonly [number, number];
  readonly entry: WorkflowCheckpointManifestEntry;
}

/**
 * The next `take` items of a selected checkpoint's manifest stream after `after`.
 *
 * The stream is every lineage checkpoint's `layer` item (ordinal -1) followed by the rows that
 * layer itself produced, oldest layer first. Lineage is the run's checkpoints up to and including
 * the selected one, because a checkpoint's parent is always the run's previous one.
 *
 * Two keyset queries, each bounded by `take`, are merged in key order. Each stream is sorted by the
 * same key and the first `take` items of the merge draw at most `take` from either, so the result is
 * exactly the first `take` items of the single logical stream. A continuation that resumes inside a
 * layer never repeats its `layer` item, and a layer that produced no rows still appears.
 */
export function manifestPage(
  db: RuntimeDrizzleDatabase,
  input: {
    readonly runId: number;
    readonly selectedRowId: number;
    readonly after: readonly [number, number] | null;
    readonly take: number;
  },
): readonly ManifestItem[] {
  const after = input.after;
  const layers: ManifestItem[] = db
    .select({ checkpoint: workflowCheckpoints, parentKey: parentKeyOf() })
    .from(workflowCheckpoints)
    .where(
      and(
        eq(workflowCheckpoints.runId, input.runId),
        lte(workflowCheckpoints.id, input.selectedRowId),
        // `(id, -1) > after`: a later layer, or this one when the key sorts before its layer item.
        ...(after === null
          ? []
          : [
              after[1] < layerOrdinal
                ? gte(workflowCheckpoints.id, after[0])
                : gt(workflowCheckpoints.id, after[0]),
            ]),
      ),
    )
    .orderBy(asc(workflowCheckpoints.id))
    .limit(input.take)
    .all()
    .map((row) => {
      const layer = { checkpoint: checkpointRecord(row.checkpoint), parentKey: row.parentKey };
      return { key: [layer.checkpoint.id, layerOrdinal] as const, entry: layerEntryDto(layer) };
    });

  const rows: ManifestItem[] = db
    .select({
      entry: workflowCheckpointEntries,
      checkpointKey: workflowCheckpoints.checkpointKey,
    })
    .from(workflowCheckpointEntries)
    .innerJoin(
      workflowCheckpoints,
      eq(workflowCheckpoints.id, workflowCheckpointEntries.checkpointId),
    )
    .where(
      and(
        eq(workflowCheckpoints.runId, input.runId),
        lte(workflowCheckpoints.id, input.selectedRowId),
        inArray(workflowCheckpointEntries.kind, ['scope', 'change', 'warning']),
        // A layer's own rows: every change, and the scopes and warnings it captured or observed.
        // Inherited coverage and region warnings belong to the layer that produced them.
        or(
          eq(workflowCheckpointEntries.kind, 'change'),
          eq(workflowCheckpointEntries.capturedByCheckpointKey, workflowCheckpoints.checkpointKey),
          eq(workflowCheckpointEntries.observedByCheckpointKey, workflowCheckpoints.checkpointKey),
        ),
        ...(after === null
          ? []
          : [
              or(
                gt(workflowCheckpoints.id, after[0]),
                and(
                  eq(workflowCheckpoints.id, after[0]),
                  gt(workflowCheckpointEntries.seq, after[1]),
                ),
              ),
            ]),
      ),
    )
    .orderBy(asc(workflowCheckpoints.id), asc(workflowCheckpointEntries.seq))
    .limit(input.take)
    .all()
    .map((row: { entry: EntryRow; checkpointKey: string }) => ({
      key: [row.entry.checkpointId, row.entry.seq] as const,
      entry: manifestEntryDto(checkpointEntryRecord(row.entry), row.checkpointKey),
    }));

  const merged: ManifestItem[] = [];
  let l = 0;
  let r = 0;
  while (merged.length < input.take && (l < layers.length || r < rows.length)) {
    const layer = layers[l];
    const row = rows[r];
    if (row === undefined || (layer !== undefined && compareKeys(layer.key, row.key) < 0)) {
      merged.push(layer!);
      l += 1;
    } else {
      merged.push(row);
      r += 1;
    }
  }
  return merged;
}

function compareKeys(a: readonly [number, number], b: readonly [number, number]): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

// ---------------------------------------------------------------------------
// File content
// ---------------------------------------------------------------------------

/**
 * A `file` entry by its public key, validated against its checkpoint and run in one query.
 *
 * `null` when no such file belongs to that checkpoint in that run; the caller tells a missing
 * checkpoint from a missing file.
 */
export function checkpointFileInRun(
  db: RuntimeDrizzleDatabase,
  input: { readonly runId: number; readonly checkpointKey: string; readonly fileKey: string },
): Extract<WorkflowCheckpointEntryRecord, { kind: 'file' }> | null {
  const row = db
    .select({ entry: workflowCheckpointEntries })
    .from(workflowCheckpointEntries)
    .innerJoin(
      workflowCheckpoints,
      eq(workflowCheckpoints.id, workflowCheckpointEntries.checkpointId),
    )
    .where(
      and(
        eq(workflowCheckpoints.runId, input.runId),
        eq(workflowCheckpoints.checkpointKey, input.checkpointKey),
        eq(workflowCheckpointEntries.fileKey, input.fileKey),
        eq(workflowCheckpointEntries.kind, 'file'),
      ),
    )
    .get();
  if (!row) return null;
  const entry = checkpointEntryRecord(row.entry);
  return entry.kind === 'file' ? entry : null;
}
