/**
 * What one `checkpoints export` reports: pure data, with no IO, so the stage and limitation
 * vocabularies can be read by the shipped skill's agreement test as well as by the exporter.
 */
import { Schema } from 'effect';

import type {
  WorkflowCheckpointBase,
  WorkflowCheckpointCounts,
  WorkflowCheckpointWarningReason,
} from '@isagi/contracts';

/** The export's stages, in the order they run. Nothing runs after the stage that failed. */
export const exportStageSchema = Schema.Literal(
  'resolve_destination',
  'read_checkpoint',
  'validate_inventory',
  'prepare_baseline',
  'apply_absences',
  'write_files',
);
export type ExportStage = typeof exportStageSchema.Type;

/** What an export cannot promise, stated on every result so no reader has to infer it. */
export const exportLimitationSchema = Schema.Literal(
  'git_baseline_is_committed_state_only',
  'no_baseline_captured_files_only',
  'dependencies_not_captured',
);
export type ExportLimitation = typeof exportLimitationSchema.Type;

export type ExportStatus = 'complete' | 'failed' | 'uncertain';

/**
 * What a failure left behind.
 *
 * `destination` means "the destination exists and is non-empty after the failure", exactly as the
 * runtime reports it for a failed worktree creation; `null` means it cannot be known (the runtime
 * may or may not have acted). `worktreeId` is set once a worktree is known to exist.
 */
export interface ExportCreated {
  readonly destination: boolean | null;
  readonly worktreeId: number | null;
}

export interface ExportFailure {
  readonly stage: ExportStage;
  readonly code: string;
  readonly reason?: string;
  readonly message: string;
  readonly requestId?: string;
  readonly data?: unknown;
  readonly created: ExportCreated;
}

export interface ExportResult {
  /** `complete` only when every stage finished; a baseline or a partial file set alone is `failed`. */
  readonly status: ExportStatus;
  readonly runId: number;
  readonly checkpointId: string;
  /** The canonical requested path; once the runtime has created a worktree, the path it returned. */
  readonly destinationPath: string;
  /** `null` only when the checkpoint itself could not be read. */
  readonly base: WorkflowCheckpointBase | null;
  /** `null` for a directory-only export, or before a worktree exists. */
  readonly worktreeId: number | null;
  readonly counts: WorkflowCheckpointCounts | null;
  readonly applied: { readonly files: number; readonly absences: number };
  /**
   * How many paths or observations each warning reason affects across the exported (resolved)
   * inventory, inherited region warnings included. Not a breakdown of `counts.warnings`, which
   * counts inventory warning rows.
   */
  readonly resolvedWarningCounts: Readonly<
    Partial<Record<WorkflowCheckpointWarningReason, number>>
  >;
  readonly limitations: readonly ExportLimitation[];
  readonly failure: ExportFailure | null;
}

export function limitationsFor(base: WorkflowCheckpointBase | null): ExportLimitation[] {
  if (base === null) return ['dependencies_not_captured'];
  return [
    base.kind === 'git'
      ? 'git_baseline_is_committed_state_only'
      : 'no_baseline_captured_files_only',
    'dependencies_not_captured',
  ];
}

/** The short summary `checkpoints export` prints without `--json`. */
export function exportSummaryText(result: ExportResult): string {
  const lines = [
    `Export ${result.status}: checkpoint ${result.checkpointId} of run ${result.runId}`,
    `  destination: ${result.destinationPath}`,
  ];
  if (result.worktreeId !== null) lines.push(`  worktree id: ${result.worktreeId}`);
  if (result.counts !== null) {
    lines.push(
      `  applied: ${result.applied.files}/${result.counts.files} files, ${result.applied.absences}/${result.counts.absences} absences`,
    );
  }
  lines.push(`  limitations: ${result.limitations.join(', ')}`);
  if (result.failure !== null) {
    const reason = result.failure.reason === undefined ? '' : ` (${result.failure.reason})`;
    lines.push(
      `  failed at ${result.failure.stage}: ${result.failure.code}${reason}: ${result.failure.message}`,
    );
    const left = result.failure.created.destination;
    lines.push(
      `  destination left on disk: ${left === null ? 'unknown, inspect it' : left ? 'yes, not cleaned up' : 'no'}`,
    );
  }
  return lines.join('\n');
}
