/**
 * The one transaction that makes a capture durable.
 *
 * It owns `workflow_evidence`, and it settles the capture operation through
 * `settleOperationWithin` so the operations repository keeps sole ownership of writes to its own
 * table. Both happen inside one transaction, and that is the whole guarantee: an `intended` or
 * `abandoned` capture can never have an evidence row, and a `completed` one always has exactly one.
 * The unique index on `operation_id` enforces "at most"; this transaction enforces "at least".
 *
 * There is no read method. Reads go through the projection, and the verb's own reuse branch reads
 * the evidence key back out of the operation's result slot — so nothing has a reason to query this
 * table through a write-owning service.
 */

import { randomUUID } from 'node:crypto';

import type { EvidenceLabels } from '@yourtechbudstudio/isagi-workflow-sdk';
import { eq } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import {
  DatabaseError,
  RuntimeDatabase,
  type RuntimeDatabaseService,
} from '../../persistence/index.js';
import { workflowEvidence, workflowOperations } from '../../persistence/schema.js';
import { settleOperationWithin } from '../persistence/operations.repository.js';
import { committed, rejected, type WorkflowWriteResult } from '../persistence/outcomes.js';
import type {
  WorkflowEvidenceContentKind,
  WorkflowEvidenceRecord,
  WorkflowOperationRecord,
} from '../persistence/records.js';
import {
  silentWriteWake,
  wakingDatabase,
  WorkflowWriteWake,
  type WorkflowWriteWakeService,
} from '../persistence/write-wake.js';
import { canonicalJson } from '../state/serializable.js';
import type { ResolvedSource } from './source.js';

export interface CommitCaptureInput {
  /** The claimed row: `intended`, or `abandoned` by a reconciliation that ran before this re-entry. */
  readonly operation: WorkflowOperationRecord;
  /**
   * The attempt committing this capture, which is `identity.attemptId` — not the operation's
   * `origin_attempt_id`. Those differ after a redispatch, and what the record means by "the attempt
   * that captured" is the one that actually made the bytes durable.
   */
  readonly attemptId: number;
  readonly title: string;
  readonly role: string;
  readonly labels: EvidenceLabels | null;
  readonly contentKind: WorkflowEvidenceContentKind;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly contentRef: string;
  readonly sourcePath: string | null;
  readonly source: ResolvedSource;
  readonly now: string;
}

export interface WorkflowEvidenceRepositoryService {
  readonly commitCapture: (
    input: CommitCaptureInput,
  ) => Effect.Effect<WorkflowWriteResult<WorkflowEvidenceRecord>, DatabaseError>;
}

export const WorkflowEvidenceRepository = Context.GenericTag<WorkflowEvidenceRepositoryService>(
  'isagi/WorkflowEvidenceRepository',
);

export function makeWorkflowEvidenceRepository(
  runtimeDatabase: Pick<RuntimeDatabaseService, 'use' | 'transaction'>,
  /** Told that a write finished, never what it wrote. Defaults to nobody listening. */
  wake: WorkflowWriteWakeService = silentWriteWake,
): WorkflowEvidenceRepositoryService {
  const database = wakingDatabase(runtimeDatabase, wake);
  return {
    commitCapture: (input) =>
      database.transaction('workflow_capture_evidence', (db) => {
        // Re-read inside the transaction rather than trusting the row the verb claimed: a
        // reconciliation can have settled this capture `abandoned` between the claim and here, and
        // deciding from a stale copy is how a row gets revived on the strength of a state it left.
        const row = db
          .select()
          .from(workflowOperations)
          .where(eq(workflowOperations.id, input.operation.id))
          .get();
        // Thrown, not rejected. `run_not_found` would send a diagnostician to the wrong table, and
        // `outcomes.ts` has no member meaning "the operation row this transaction just claimed has
        // vanished" — because that is not an expected outcome, it is a broken invariant. Widening a
        // union every workflow write consumes, for a state nothing can legitimately produce, would
        // buy less than failing loudly. Same posture as `settleOperationWithin`'s reopen
        // precondition: unreachable by construction, so a precondition rather than a fallback.
        if (!row) {
          throw new Error(
            `Evidence capture cannot commit: operation ${input.operation.operationKey} (id ${input.operation.id}) no longer exists.`,
          );
        }
        if (row.state !== 'intended' && row.state !== 'abandoned') {
          return rejected<WorkflowEvidenceRecord>({
            kind: 'operation_state_conflict',
            state: row.state,
          });
        }

        const evidenceKey = `wev_${randomUUID()}`;
        // Placement is copied from the operation rather than joined at read time, so a listing is a
        // single indexed scan and the row reads as evidence on its own.
        const inserted = db
          .insert(workflowEvidence)
          .values({
            evidenceKey,
            runId: row.runId,
            frameId: row.frameId,
            executionId: row.executionId,
            attemptId: input.attemptId,
            operationId: row.id,
            artifactHash: row.artifactHash,
            title: input.title,
            role: input.role,
            labelsJson: canonicalJson(input.labels ?? {}),
            contentKind: input.contentKind,
            mediaType: input.mediaType,
            byteSize: input.byteSize,
            contentRef: input.contentRef,
            sourcePath: input.sourcePath,
            sourceKind: input.source.kind,
            sourceAgentSessionId: input.source.agentSessionId,
            sourceOperationId: input.source.operationId,
            sourceAttribution: input.source.attribution,
            capturedAt: input.now,
          })
          .returning()
          .get();

        // `reopenAbandoned` because reconciliation runs before *every* callback re-entry, not only
        // after a restart — so a capture that failed after recording intent is always `abandoned`
        // by the time the retried callback reaches it. Without the escape, `abandoned` would be
        // terminal for a capability that has no receipt stage to advance through, and the commit
        // would be refused forever. The abandonment stays in the transition history either way.
        const settled = settleOperationWithin(db, {
          row,
          state: 'completed',
          result: { inline: canonicalJson({ evidenceKey }), ref: null },
          reopenAbandoned: true,
          now: input.now,
        });
        if (!settled.ok) return rejected<WorkflowEvidenceRecord>(settled.rejection);

        return committed(evidenceRecord(inserted), settled.transitions);
      }),
  };
}

export const WorkflowEvidenceRepositoryLive = Layer.effect(
  WorkflowEvidenceRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const wake = yield* WorkflowWriteWake;
    return makeWorkflowEvidenceRepository(database, wake);
  }),
);

type EvidenceRow = typeof workflowEvidence.$inferSelect;

function evidenceRecord(row: EvidenceRow): WorkflowEvidenceRecord {
  return {
    id: row.id,
    evidenceKey: row.evidenceKey,
    runId: row.runId,
    frameId: row.frameId,
    executionId: row.executionId,
    attemptId: row.attemptId,
    operationId: row.operationId,
    artifactHash: row.artifactHash,
    title: row.title,
    role: row.role,
    labels: readLabels(row.labelsJson),
    contentKind: row.contentKind,
    mediaType: row.mediaType,
    byteSize: row.byteSize,
    contentRef: row.contentRef,
    sourcePath: row.sourcePath,
    sourceKind: row.sourceKind,
    sourceAgentSessionId: row.sourceAgentSessionId,
    sourceOperationId: row.sourceOperationId,
    sourceAttribution: row.sourceAttribution,
    capturedAt: row.capturedAt,
  };
}

/**
 * Tolerant, like every other column decoder here: a row whose labels will not parse is still a
 * record of something that was captured, and losing the whole row over its filter metadata would be
 * the opposite of what this table is for.
 */
function readLabels(value: string): Readonly<Record<string, string | number | boolean>> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, string | number | boolean>;
  } catch {
    return {};
  }
}
