import { Schema } from 'effect';

import {
  workflowPlacementRequestSchema,
  workflowSetupReceiptSchema,
  workflowSurfaceReceiptSchema,
  workflowWorktreeReceiptSchema,
  type WorkflowEnvironmentStep,
  type WorkflowPlacementRequestDto,
  type WorkflowSetupReceipt,
  type WorkflowSurfaceReceipt,
  type WorkflowWorktreeReceipt,
} from '@isagi/contracts';

import type { workflowRunPreparations } from '../../persistence/schema.js';
import type { WorkflowRunPreparationRecord } from './records.js';

type PreparationRow = typeof workflowRunPreparations.$inferSelect;

/**
 * A preparation row holds a value this runtime wrote and cannot read back.
 *
 * Same posture as `CorruptRunPositionError`: a defect, not an operational condition. Every column
 * decoded here was written by the engine through the same contract schema, so a failure means the
 * row was corrupted or hand-edited, never that a caller sent something unexpected. Falling back to
 * a plausible default would be worse than failing — a guessed placement request relocates a run,
 * and a guessed receipt makes a retry create a second worktree instead of reusing the first.
 */
export class CorruptRunPreparationError extends Error {
  readonly _tag = 'CorruptRunPreparationError';
  constructor(
    readonly runId: number,
    readonly column: string,
    readonly detail: string,
  ) {
    super(`Run ${runId} has an unreadable preparation ${column}: ${detail}`);
  }
}

const decodeRequest = Schema.decodeUnknownSync(workflowPlacementRequestSchema);
const decodeWorktree = Schema.decodeUnknownSync(workflowWorktreeReceiptSchema);
const decodeSetup = Schema.decodeUnknownSync(workflowSetupReceiptSchema);
const decodeSurface = Schema.decodeUnknownSync(workflowSurfaceReceiptSchema);

function decodeColumn<A>(
  runId: number,
  column: string,
  json: string,
  decode: (value: unknown) => A,
): A {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (cause) {
    throw new CorruptRunPreparationError(runId, column, `not valid JSON (${String(cause)})`);
  }
  try {
    return decode(parsed);
  } catch (cause) {
    throw new CorruptRunPreparationError(runId, column, String(cause));
  }
}

/** The placement that was asked for. Never what was obtained — that is the run's destination. */
export function decodePlacementRequest(runId: number, json: string): WorkflowPlacementRequestDto {
  return decodeColumn(runId, 'request', json, decodeRequest);
}

export function decodeWorktreeReceipt(runId: number, json: string): WorkflowWorktreeReceipt {
  return decodeColumn(runId, 'worktree receipt', json, decodeWorktree);
}

export function decodeSetupReceipt(runId: number, json: string): WorkflowSetupReceipt {
  return decodeColumn(runId, 'setup receipt', json, decodeSetup);
}

export function decodeSurfaceReceipt(runId: number, json: string): WorkflowSurfaceReceipt {
  return decodeColumn(runId, 'surface receipt', json, decodeSurface);
}

/**
 * Decodes one preparation row.
 *
 * A null receipt column means *nothing was allocated for that step* — a reused worktree or surface
 * leaves no receipt — so null decodes to null rather than to an empty receipt. The distinction is
 * load-bearing: it is what lets a failure name only the resources this launch created, and a retry
 * tell "reuse what exists" apart from "create it now".
 */
export function preparationRecord(row: PreparationRow): WorkflowRunPreparationRecord {
  return {
    runId: row.runId,
    source: row.source,
    request: decodePlacementRequest(row.runId, row.requestJson),
    baseCommit: row.baseCommit,
    checkoutPath: row.checkoutPath,
    worktree:
      row.worktreeReceiptJson === null
        ? null
        : decodeWorktreeReceipt(row.runId, row.worktreeReceiptJson),
    setup:
      row.setupReceiptJson === null ? null : decodeSetupReceipt(row.runId, row.setupReceiptJson),
    surface:
      row.surfaceReceiptJson === null
        ? null
        : decodeSurfaceReceipt(row.runId, row.surfaceReceiptJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function encodePlacementRequest(request: WorkflowPlacementRequestDto): string {
  return JSON.stringify(request);
}

export function encodeWorktreeReceipt(receipt: WorkflowWorktreeReceipt): string {
  return JSON.stringify(receipt);
}

export function encodeSetupReceipt(receipt: WorkflowSetupReceipt): string {
  return JSON.stringify(receipt);
}

export function encodeSurfaceReceipt(receipt: WorkflowSurfaceReceipt): string {
  return JSON.stringify(receipt);
}

/**
 * The first **allocation** this preparation still owes, and therefore where a re-entry resumes.
 *
 * Named by allocation rather than by step, because only an allocation leaves a receipt. Reuse
 * choices create nothing, leave no receipt and are re-validated against live rows on every attempt,
 * so they are never the answer — a `current` worktree is not "incomplete", it is not this
 * preparation's to complete at all.
 *
 * Lives here, beside the decoders, and is exported because three callers need the same answer:
 * startup recovery names the step an interrupted preparation died at, the preparation segment
 * decides per step whether to reuse a receipt or act, and the read projection reports progress. A
 * second copy of "which allocation is outstanding" would decide whether a retry reuses an existing
 * worktree or creates a second one, which is the most consequential thing here to get inconsistent.
 *
 * A `setup` receipt that is `failed` or `unknown` counts as outstanding: hooks may still need to
 * run. It is also the one receipt a later attempt may replace, which is the same fact seen from the
 * write side.
 */
export function firstIncompleteStep(record: WorkflowRunPreparationRecord): WorkflowEnvironmentStep {
  if (record.request.worktree.kind === 'create') {
    if (record.worktree === null) return 'worktree';
    if (
      record.setup === null ||
      record.setup.status === 'failed' ||
      record.setup.status === 'unknown'
    ) {
      return 'setup';
    }
  }
  if (record.request.surface.kind === 'create' && record.surface === null) return 'surface';
  return 'commit';
}
