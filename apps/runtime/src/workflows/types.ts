import type {
  WorkflowWaitCondition,
  WorkflowWaitKind,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { Data } from 'effect';

import type { DatabaseError } from '../persistence/index.js';

export type {
  WorkflowAgentHarness,
  WorkflowCommandManifest,
  WorkflowContext,
  WorkflowConversationMessage,
  WorkflowConversationPart,
  WorkflowConversationRole,
  WorkflowDefinition,
  WorkflowHeadlessResult,
  WorkflowInvocation,
  WorkflowLaunchContext,
  WorkflowQuestionOption,
  WorkflowQuestionSpec,
  WorkflowResult,
  WorkflowStep,
  WorkflowUiFeedback,
  WorkflowVariables,
  WorkflowWaitCondition,
  WorkflowWaitKind,
} from '@yourtechbudstudio/isagi-workflow-sdk';

export type WorkflowStatus = 'waiting' | 'ready' | 'running' | 'done' | 'failed';

export interface WorkflowRunRow {
  readonly id: number;
  readonly workflowKey: string;
  readonly workflowTitle: string;
  readonly workflowArtifactHash: string | null;
  readonly worktreeId: number | null;
  readonly surfaceId: number | null;
  readonly parentRunId: number | null;
  readonly rootRunId: number | null;
  readonly status: WorkflowStatus;
  readonly retrying: boolean;
  readonly paused: boolean;
  readonly cancelRequested: boolean;
  readonly waitKind: WorkflowWaitKind | null;
  readonly waitCondition: string | null;
  readonly resumePayload: string | null;
  readonly stateJson: string;
  readonly stateVersion: number;
  readonly owner: string | null;
  readonly error: string | null;
  readonly resultJson: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type WorkflowEngineServiceError = WorkflowEngineError | DatabaseError;

export class WorkflowEngineError extends Data.TaggedError('WorkflowEngineError')<{
  readonly code:
    | 'unknown_workflow_key'
    | 'workflow_discovery_failed'
    | 'workflow_load_failed'
    | 'no_active_worktree'
    | 'worktree_not_found'
    | 'surface_not_found'
    | 'surface_worktree_mismatch'
    | 'pane_not_found'
    | 'agent_session_not_on_surface'
    | 'workflow_launch_context_mismatch'
    | 'validation_failed'
    | 'workflow_root_surface_required'
    | 'workflow_root_run_required'
    | 'workflow_surface_busy'
    | 'workflow_run_not_found'
    | 'workflow_run_not_paused'
    | 'workflow_run_not_failed'
    | 'workflow_wait_not_satisfiable'
    | 'workflow_user_input_invalid';
  readonly message: string;
  readonly workflowKey?: string | undefined;
  readonly workflowLoadFailureReason?:
    | import('@isagi/contracts').WorkflowLoadFailureReason
    | undefined;
  readonly workflowSourceDirectory?: string | undefined;
  readonly workflowPackageDirectory?: string | undefined;
  readonly shadowedWorkflowPackageDirectories?: readonly string[] | undefined;
  readonly knownWorkflowKeys?: readonly string[] | undefined;
  readonly workflowRunId?: number | undefined;
  readonly activeWorkflowRunId?: number | undefined;
  readonly operation?: string | undefined;
  readonly worktreeId?: number | undefined;
  readonly surfaceId?: number | undefined;
  readonly paneId?: number | undefined;
  readonly agentSessionId?: number | undefined;
}> {}

export function waitKind(condition: WorkflowWaitCondition): WorkflowWaitKind {
  return condition.kind;
}
