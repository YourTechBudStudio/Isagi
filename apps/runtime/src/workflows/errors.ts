import type { StructureDiagnostic } from '@yourtechbudstudio/isagi-workflow-verifier/structure';
import { Data } from 'effect';

import type { WorkflowLoadFailureReason, WorkflowRejectionReason } from '@isagi/contracts';

export type WorkflowControl = 'pause' | 'resume' | 'retry' | 'cancel' | 'dismiss' | 'advance';

/**
 * An expected workflow failure, named with the wire's own reason vocabulary.
 *
 * The engine decides in the contract's reasons, so the API layer only copies context onto the
 * envelope and never renames or invents a reason. Every optional field mirrors a context field of
 * `workflowRejectionDataSchema`.
 */
export class WorkflowEngineError extends Data.TaggedError('WorkflowEngineError')<{
  /** Checkpoint export's destination refusal carries its own required context; phase 03 adds it. */
  readonly code: Exclude<WorkflowRejectionReason, 'workflow_checkpoint_destination_rejected'>;
  readonly message: string;
  readonly workflowKey?: string | undefined;
  readonly workflowRunId?: number | undefined;
  readonly activeWorkflowRunId?: number | undefined;
  readonly worktreeId?: number | undefined;
  readonly surfaceId?: number | undefined;
  readonly paneId?: number | undefined;
  readonly agentSessionId?: number | undefined;
  readonly executionId?: number | undefined;
  readonly operationId?: number | undefined;
  readonly checkpointId?: number | undefined;
  readonly control?: WorkflowControl | undefined;
  readonly workflowLoadFailureReason?: WorkflowLoadFailureReason | undefined;
  readonly workflowSourceDirectory?: string | undefined;
  readonly workflowPackageDirectory?: string | undefined;
  readonly shadowedWorkflowPackageDirectories?: readonly string[] | undefined;
  readonly placementIssue?:
    | 'surface_not_on_worktree'
    | 'worktree_not_in_project'
    | 'invalid_surface_title'
    | undefined;
  readonly collision?: 'branch' | 'worktree' | 'checkout_path' | undefined;
  readonly branch?: string | undefined;
  readonly baseRef?: string | undefined;
  readonly projectId?: number | undefined;
  /** Which registrations no longer fit, for the structure and code-incompatible reasons. */
  readonly diagnostics?: readonly StructureDiagnostic[] | undefined;
}> {}
