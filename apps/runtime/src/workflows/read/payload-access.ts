import { and, eq, or, sql } from 'drizzle-orm';

import type { RuntimeDrizzleDatabase } from '../../persistence/database.service.js';
import {
  workflowArtifacts,
  workflowGraphFrames,
  workflowOperations,
  workflowRuns,
  workflowSegmentAttempts,
  workflowTransitions,
  workflowVersionAdoptions,
  workflowWaits,
} from '../../persistence/schema.js';

/**
 * Run-scoped payload authorization.
 *
 * The payload route is not a general content-read endpoint: a reference is servable only through the
 * run that recorded it. Every column that can hold one is checked, including the retained descriptors
 * of versions this run adopted, because an old definition's structure is part of what inspecting this
 * run can legitimately show.
 */

/**
 * Whether this run recorded the reference at all.
 *
 * Every column that can hold one is checked, including the retained descriptors of versions the run
 * adopted, because an old definition's descriptor is part of what this run's inspection can show.
 */
export function payloadBelongsToRun(
  db: RuntimeDrizzleDatabase,
  runId: number,
  payloadRef: string,
): boolean {
  const exists = (query: { readonly value: number } | undefined) => (query?.value ?? 0) > 0;

  const run = db
    .select({ outputRef: workflowRuns.outputRef })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .get();
  if (run?.outputRef === payloadRef) return true;

  const frames = db
    .select({ value: sql<number>`count(*)` })
    .from(workflowGraphFrames)
    .where(
      and(
        eq(workflowGraphFrames.runId, runId),
        or(
          eq(workflowGraphFrames.parametersRef, payloadRef),
          eq(workflowGraphFrames.stateRef, payloadRef),
          eq(workflowGraphFrames.outputRef, payloadRef),
        ),
      ),
    )
    .get();
  if (exists(frames)) return true;

  const attempts = db
    .select({ value: sql<number>`count(*)` })
    .from(workflowSegmentAttempts)
    .where(
      and(
        eq(workflowSegmentAttempts.runId, runId),
        or(
          eq(workflowSegmentAttempts.inputRef, payloadRef),
          eq(workflowSegmentAttempts.producerOutputRef, payloadRef),
          eq(workflowSegmentAttempts.failureDetailRef, payloadRef),
        ),
      ),
    )
    .get();
  if (exists(attempts)) return true;

  const transitions = db
    .select({ value: sql<number>`count(*)` })
    .from(workflowTransitions)
    .where(
      and(
        eq(workflowTransitions.runId, runId),
        or(
          eq(workflowTransitions.stateRef, payloadRef),
          eq(workflowTransitions.detailRef, payloadRef),
        ),
      ),
    )
    .get();
  if (exists(transitions)) return true;

  const operations = db
    .select({ value: sql<number>`count(*)` })
    .from(workflowOperations)
    .where(
      and(
        eq(workflowOperations.runId, runId),
        or(
          eq(workflowOperations.requestRef, payloadRef),
          eq(workflowOperations.receiptRef, payloadRef),
          eq(workflowOperations.resultRef, payloadRef),
          eq(workflowOperations.lateEvidenceRef, payloadRef),
        ),
      ),
    )
    .get();
  if (exists(operations)) return true;

  const waits = db
    .select({ value: sql<number>`count(*)` })
    .from(workflowWaits)
    .where(
      and(
        eq(workflowWaits.runId, runId),
        or(eq(workflowWaits.conditionRef, payloadRef), eq(workflowWaits.eventRef, payloadRef)),
      ),
    )
    .get();
  if (exists(waits)) return true;

  const descriptors = db
    .select({ value: sql<number>`count(*)` })
    .from(workflowArtifacts)
    .innerJoin(
      workflowVersionAdoptions,
      eq(workflowVersionAdoptions.artifactHash, workflowArtifacts.artifactHash),
    )
    .where(
      and(
        eq(workflowVersionAdoptions.runId, runId),
        eq(workflowArtifacts.descriptorRef, payloadRef),
      ),
    )
    .get();
  return exists(descriptors);
}
