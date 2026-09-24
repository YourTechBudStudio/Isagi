/**
 * The sole writer of `workflow_checkpoints` and `workflow_checkpoint_entries`.
 *
 * One transaction makes a checkpoint durable: its row and every entry row, or nothing. Rows are never
 * updated afterwards, which is what lets every page of an inventory read identically however long
 * after the capture it is taken. The run position is not written here — the segment commits it
 * through the runs repository after this transaction (ADR 0008) — and there is no write wake,
 * because a checkpoint row is not a run transition and that commit wakes the publisher anyway.
 *
 * The reads here serve the write path only: the segment's receipt check, the capture's choice of
 * parent, and the parent's resolved state the fold starts from. Reading its own tables for a write
 * it is about to make is ownership, not read composition. Public reads go through the projection.
 */

import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, isNotNull, lte, or } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import {
  workflowCheckpointRegionWarningReasonSchema,
  type WorkflowCheckpointBase,
  type WorkflowCheckpointRegionWarningReason,
} from '@isagi/contracts';

import {
  DatabaseError,
  RuntimeDatabase,
  type RuntimeDatabaseService,
} from '../../persistence/index.js';
import { workflowCheckpointEntries, workflowCheckpoints } from '../../persistence/schema.js';
import type { WorkflowCheckpointRecord } from '../persistence/records.js';
import { checkpointEntryRecord, checkpointRecord } from '../persistence/row-mappers.js';
import { canonicalJson } from '../state/serializable.js';
import type {
  CheckpointCounts,
  CheckpointEntry,
  ParentResolvedState,
  Region,
  ResolvedFile,
  ScopeBinding,
  StoredWarning,
} from './resolve.js';
import { warningGroupsOf } from './warning-groups.js';

export interface CommitCheckpointInput {
  readonly runId: number;
  readonly frameId: number;
  readonly executionId: number;
  readonly attemptId: number;
  readonly artifactHash: string;
  readonly nodeId: string;
  /** Minted by the capture before the fold, so entries can name their own checkpoint. */
  readonly checkpointKey: string;
  readonly parentCheckpointId: number | null;
  readonly title: string;
  readonly base: WorkflowCheckpointBase;
  readonly repositoryProjectId: number;
  readonly repositoryRootPath: string;
  /** In `seq` order; `seq` is each entry's index. */
  readonly entries: readonly CheckpointEntry[];
  readonly counts: CheckpointCounts;
  readonly now: string;
}

/** What #50's domain-owned cleanup needs to know about a run's checkpoints before rows go. */
export interface CheckpointRetention {
  readonly checkpointKey: string;
  readonly repositoryProjectId: number;
  /** Distinct references from final file rows and historical change rows. */
  readonly contentRefs: readonly string[];
}

export interface WorkflowCheckpointRepositoryService {
  /**
   * One transaction: the checkpoint row, then every entry with a minted `wcf_` key on file rows.
   * A pre-existing row for the execution is a broken invariant — the segment checked its receipt
   * under the attempt fence — so the unique index fails the transaction as a `DatabaseError`.
   */
  readonly commitCapture: (
    input: CommitCheckpointInput,
  ) => Effect.Effect<WorkflowCheckpointRecord, DatabaseError>;
  readonly findByExecution: (
    executionId: number,
  ) => Effect.Effect<WorkflowCheckpointRecord | null, DatabaseError>;
  /** The run's most recently committed checkpoint: the next capture's parent. */
  readonly findLatestInRun: (
    runId: number,
  ) => Effect.Effect<WorkflowCheckpointRecord | null, DatabaseError>;
  /** The state a child's fold starts from: files, coverage, region warnings and scope bindings. */
  readonly resolvedStateOf: (
    checkpointId: number,
  ) => Effect.Effect<ParentResolvedState, DatabaseError>;
  /** A read for #50, consumed before rows are deleted; not a deletion API. */
  readonly listRetentionForRuns: (
    runIds: readonly number[],
  ) => Effect.Effect<readonly CheckpointRetention[], DatabaseError>;
}

export const WorkflowCheckpointRepository = Context.GenericTag<WorkflowCheckpointRepositoryService>(
  'isagi/WorkflowCheckpointRepository',
);

const regionWarningReasons: ReadonlySet<string> = new Set(
  workflowCheckpointRegionWarningReasonSchema.literals,
);

type EntryInsert = typeof workflowCheckpointEntries.$inferInsert;

/**
 * The per-kind representation invariants, checked before the insert so a violation names the entry
 * rather than surfacing as an anonymous CHECK failure. Thrown: the fold produced it, so it is a
 * defect, never an author-facing outcome.
 */
function entryRow(checkpointId: number, seq: number, entry: CheckpointEntry): EntryInsert {
  const placement = { checkpointId, seq, kind: entry.kind };
  const requirePath = (path: string | null) => {
    if (path === null || path.length === 0) {
      throw new Error(`Checkpoint entry ${seq} (${entry.kind}) has no path.`);
    }
    return path;
  };
  switch (entry.kind) {
    case 'scope':
      return {
        ...placement,
        path: requirePath(entry.path),
        scopeId: entry.scopeId,
        scopeKind: entry.scopeKind,
        exclusionsJson: canonicalJson([...entry.exclusions]),
        capturedByCheckpointKey: entry.capturedBy,
      };
    case 'file':
      return {
        ...placement,
        path: requirePath(entry.path),
        fileKey: `wcf_${randomUUID()}`,
        contentRef: entry.contentRef,
        byteSize: entry.byteSize,
        executable: entry.executable,
      };
    case 'absent':
      return { ...placement, path: requirePath(entry.path) };
    case 'warning':
      return {
        ...placement,
        path: entry.path,
        scopeId: entry.scopeId,
        warningReason: entry.reason,
        warningDetailJson: entry.detail === null ? null : canonicalJson({ ...entry.detail }),
        observedByCheckpointKey: entry.observedBy,
      };
    case 'change':
      return entry.operation === 'delete'
        ? { ...placement, path: requirePath(entry.path), changeOperation: 'delete' }
        : {
            ...placement,
            path: requirePath(entry.path),
            changeOperation: entry.operation,
            contentRef: entry.contentRef,
            byteSize: entry.byteSize,
            executable: entry.executable,
          };
  }
}

function assertCountsMatch(input: CommitCheckpointInput): void {
  const count = (kind: CheckpointEntry['kind']) =>
    input.entries.filter((entry) => entry.kind === kind).length;
  const actual = {
    scopes: count('scope'),
    files: count('file'),
    absences: count('absent'),
    warnings: count('warning'),
  };
  if (
    actual.scopes !== input.counts.scopes ||
    actual.files !== input.counts.files ||
    actual.absences !== input.counts.absences ||
    actual.warnings !== input.counts.warnings
  ) {
    throw new Error(
      `Checkpoint ${input.checkpointKey} counts ${JSON.stringify(input.counts)} disagree with its entries ${JSON.stringify(actual)}.`,
    );
  }
}

export function makeWorkflowCheckpointRepository(
  database: Pick<RuntimeDatabaseService, 'use' | 'transaction'>,
): WorkflowCheckpointRepositoryService {
  return {
    commitCapture: (input) =>
      database.transaction('workflow_commit_checkpoint', (db) => {
        assertCountsMatch(input);
        const base = input.base;
        // A git base's repository is the project the capture read; recording another would make
        // `repositoryId` and the provenance columns disagree about one fact.
        if (base.kind === 'git' && base.repositoryId !== input.repositoryProjectId) {
          throw new Error(
            `Checkpoint ${input.checkpointKey} names repository ${base.repositoryId} but was captured from project ${input.repositoryProjectId}.`,
          );
        }
        const row = db
          .insert(workflowCheckpoints)
          .values({
            checkpointKey: input.checkpointKey,
            runId: input.runId,
            frameId: input.frameId,
            executionId: input.executionId,
            attemptId: input.attemptId,
            artifactHash: input.artifactHash,
            parentCheckpointId: input.parentCheckpointId,
            nodeId: input.nodeId,
            title: input.title,
            baseKind: base.kind,
            baseReason: base.kind === 'none' ? base.reason : null,
            baseCommitSha: base.kind === 'git' ? base.commitSha : null,
            repositoryProjectId: input.repositoryProjectId,
            repositoryRootPath: input.repositoryRootPath,
            scopeCount: input.counts.scopes,
            fileCount: input.counts.files,
            absentCount: input.counts.absences,
            warningCount: input.counts.warnings,
            // Derived from the entries below, in this transaction, so it cannot disagree with them.
            warningGroupsJson: canonicalJson(warningGroupsOf(input.entries, input.checkpointKey)),
            createdAt: input.now,
          })
          .returning()
          .get();
        // Chunked because SQLite bounds the number of bound parameters per statement.
        const rows = input.entries.map((entry, seq) => entryRow(row.id, seq, entry));
        for (let start = 0; start < rows.length; start += 500) {
          db.insert(workflowCheckpointEntries)
            .values(rows.slice(start, start + 500))
            .run();
        }
        return checkpointRecord(row);
      }),

    findByExecution: (executionId) =>
      database.use('workflow_find_checkpoint_by_execution', (db) => {
        const row = db
          .select()
          .from(workflowCheckpoints)
          .where(eq(workflowCheckpoints.executionId, executionId))
          .get();
        return row ? checkpointRecord(row) : null;
      }),

    findLatestInRun: (runId) =>
      database.use('workflow_find_latest_checkpoint', (db) => {
        const row = db
          .select()
          .from(workflowCheckpoints)
          .where(eq(workflowCheckpoints.runId, runId))
          .orderBy(desc(workflowCheckpoints.id))
          .limit(1)
          .get();
        return row ? checkpointRecord(row) : null;
      }),

    resolvedStateOf: (checkpointId) =>
      database.use('workflow_checkpoint_resolved_state', (db) => {
        const owner = db
          .select({ id: workflowCheckpoints.id, runId: workflowCheckpoints.runId })
          .from(workflowCheckpoints)
          .where(eq(workflowCheckpoints.id, checkpointId))
          .get();
        if (!owner) throw new Error(`Checkpoint ${checkpointId} does not exist.`);

        // (a) The checkpoint's own final state: file, scope and region-warning rows.
        const files = new Map<string, ResolvedFile>();
        const coverage: Region[] = [];
        const regionWarnings: StoredWarning[] = [];
        const rows = db
          .select()
          .from(workflowCheckpointEntries)
          .where(
            and(
              eq(workflowCheckpointEntries.checkpointId, checkpointId),
              inArray(workflowCheckpointEntries.kind, ['scope', 'file', 'warning']),
            ),
          )
          .orderBy(asc(workflowCheckpointEntries.seq))
          .all();
        for (const row of rows) {
          const entry = checkpointEntryRecord(row);
          if (entry.kind === 'file') {
            files.set(entry.path, {
              path: entry.path,
              contentRef: entry.contentRef,
              byteSize: entry.byteSize,
              executable: entry.executable,
            });
          } else if (entry.kind === 'scope') {
            coverage.push({
              scopeId: entry.scopeId,
              kind: entry.scopeKind,
              path: entry.path,
              exclusions: entry.exclusions,
              capturedBy: entry.capturedBy,
            });
          } else if (entry.kind === 'warning' && regionWarningReasons.has(entry.reason)) {
            regionWarnings.push({
              reason: entry.reason as WorkflowCheckpointRegionWarningReason,
              path: entry.path,
              scopeId: entry.scopeId,
              detail: entry.detail,
              observedBy: entry.observedBy,
            });
          }
        }

        // (b) Latest bindings over the lineage: every scope row a layer wrote for itself, oldest
        // layer first, so the last write per scope id wins. A binding survives its region being
        // superseded, which is what keeps a scope id's identity for the whole run.
        const bindings = new Map<string, ScopeBinding>();
        const lineage = db
          .select({ entry: workflowCheckpointEntries })
          .from(workflowCheckpointEntries)
          .innerJoin(
            workflowCheckpoints,
            eq(workflowCheckpoints.id, workflowCheckpointEntries.checkpointId),
          )
          .where(
            and(
              eq(workflowCheckpoints.runId, owner.runId),
              lte(workflowCheckpoints.id, checkpointId),
              eq(workflowCheckpointEntries.kind, 'scope'),
              eq(
                workflowCheckpointEntries.capturedByCheckpointKey,
                workflowCheckpoints.checkpointKey,
              ),
            ),
          )
          .orderBy(asc(workflowCheckpoints.id), asc(workflowCheckpointEntries.seq))
          .all();
        for (const { entry: row } of lineage) {
          const entry = checkpointEntryRecord(row);
          if (entry.kind !== 'scope') continue;
          bindings.set(entry.scopeId, {
            scopeId: entry.scopeId,
            kind: entry.scopeKind,
            path: entry.path,
            exclusions: entry.exclusions,
          });
        }
        return { files, coverage, regionWarnings, bindings };
      }),

    listRetentionForRuns: (runIds) =>
      database.use('workflow_list_checkpoint_retention', (db) => {
        if (runIds.length === 0) return [];
        const checkpoints = db
          .select()
          .from(workflowCheckpoints)
          .where(inArray(workflowCheckpoints.runId, [...runIds]))
          .orderBy(asc(workflowCheckpoints.id))
          .all();
        if (checkpoints.length === 0) return [];
        const refs = db
          .selectDistinct({
            checkpointId: workflowCheckpointEntries.checkpointId,
            contentRef: workflowCheckpointEntries.contentRef,
          })
          .from(workflowCheckpointEntries)
          .where(
            and(
              inArray(
                workflowCheckpointEntries.checkpointId,
                checkpoints.map((checkpoint) => checkpoint.id),
              ),
              or(
                eq(workflowCheckpointEntries.kind, 'file'),
                eq(workflowCheckpointEntries.kind, 'change'),
              ),
              isNotNull(workflowCheckpointEntries.contentRef),
            ),
          )
          .orderBy(
            asc(workflowCheckpointEntries.checkpointId),
            asc(workflowCheckpointEntries.contentRef),
          )
          .all();
        const byCheckpoint = new Map<number, string[]>();
        for (const { checkpointId, contentRef } of refs) {
          if (contentRef === null) continue;
          const list = byCheckpoint.get(checkpointId) ?? [];
          list.push(contentRef);
          byCheckpoint.set(checkpointId, list);
        }
        return checkpoints.map((checkpoint) => ({
          checkpointKey: checkpoint.checkpointKey,
          repositoryProjectId: checkpoint.repositoryProjectId,
          contentRefs: byCheckpoint.get(checkpoint.id) ?? [],
        }));
      }),
  };
}

export const WorkflowCheckpointRepositoryLive = Layer.effect(
  WorkflowCheckpointRepository,
  Effect.map(RuntimeDatabase, makeWorkflowCheckpointRepository),
);
