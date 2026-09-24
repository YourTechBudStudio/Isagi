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
 * Lives here, beside the decoders, and is exported because two callers need the same answer:
 * startup recovery names the step an interrupted preparation died at, and the preparation segment
 * decides per step whether to reuse a receipt or act. A second copy of "which allocation is
 * outstanding" would decide whether a retry reuses an existing worktree or creates a second one,
 * which is the most consequential thing here to get inconsistent.
 *
 * The read projection is deliberately **not** a caller: the run summary reports the receipts
 * themselves and derives nothing from them, because the receipts are the progress record and a
 * derived step would be a second authority over the same fact.
 *
 * A `setup` receipt that is not known good counts as outstanding — see {@link setupIsIncomplete},
 * which the preparation segment consults for the same decision. It is also the one receipt a later
 * attempt may replace, which is the same fact seen from the write side.
 */
export function firstIncompleteStep(record: WorkflowRunPreparationRecord): WorkflowEnvironmentStep {
  if (record.request.worktree.kind === 'create') {
    if (record.worktree === null) return 'worktree';
    if (setupIsIncomplete(record.setup)) return 'setup';
  }
  if (record.request.surface.kind === 'create' && record.surface === null) return 'surface';
  return 'commit';
}

/**
 * Whether this worktree's setup hooks are **not known to be good**, and so must run.
 *
 * One sentence, in one place, because two callers act on it in opposite directions and a
 * disagreement between them is invisible: the preparation segment re-runs hooks when this is true,
 * and the progress projection reports the run as sitting at `setup`. Split those apart and the
 * inspector says `commit` while the segment re-runs hooks, or hooks never run on a worktree the
 * inspector calls incomplete — a divergence no test would catch unless it happened to pin both.
 *
 * `null` is a real state, not a missing one: the worktree receipt and the setup receipt are separate
 * transactions, so a crash between them leaves setup null, and reading that as "done" would hand the
 * run a checkout whose hooks never ran. `unknown` says the same thing about an adopted checkout
 * nobody observed.
 *
 * Deliberately a `switch` with no `default`, over a receipt rather than the whole record: a fifth
 * status added to `workflowSetupReceiptSchema` is a one-line change, and this is where it has to be
 * a compile error rather than a silent choice about somebody's hooks.
 */
export function setupIsIncomplete(setup: WorkflowSetupReceipt | null): boolean {
  if (setup === null) return true;
  switch (setup.status) {
    case 'succeeded':
    case 'skipped':
      return false;
    case 'failed':
    case 'unknown':
      return true;
  }
}
