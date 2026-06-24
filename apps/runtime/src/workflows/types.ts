import { Data } from 'effect';

import type { WorkflowWaitCondition, WorkflowWaitKind } from '@isagi/workflow-sdk';

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
  WorkflowLaunchContext,
  WorkflowQuestionOption,
  WorkflowQuestionSpec,
  WorkflowResult,
  WorkflowStep,
  WorkflowUiFeedback,
  WorkflowVariables,
  WorkflowWaitCondition,
  WorkflowWaitKind,
} from '@isagi/workflow-sdk';

export type WorkflowStatus = 'paused' | 'waiting' | 'ready' | 'running' | 'done' | 'failed';

export interface WorkflowRunRow {
  readonly id: number;
  readonly workflowKey: string;
  readonly worktreeId: number | null;
  readonly surfaceId: number | null;
  readonly status: WorkflowStatus;
  readonly waitKind: WorkflowWaitKind | null;
  readonly waitCondition: string | null;
  readonly resumePayload: string | null;
  readonly stateJson: string;
  readonly stateVersion: number;
  readonly owner: string | null;
  readonly uiFeedback: string | null;
  readonly error: string | null;
  readonly resultJson: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type WorkflowEngineServiceError = WorkflowEngineError | DatabaseError;

export class WorkflowEngineError extends Data.TaggedError('WorkflowEngineError')<{
  readonly code:
    | 'unknown_workflow_key'
    | 'workflow_load_failed'
    | 'no_active_worktree'
    | 'worktree_not_found'
    | 'surface_not_found'
    | 'surface_worktree_mismatch'
    | 'pane_not_found'
    | 'agent_session_not_on_surface'
    | 'validation_failed'
    | 'workflow_run_not_found'
    | 'workflow_run_not_paused'
    | 'workflow_wait_not_satisfiable'
    | 'workflow_user_input_invalid';
  readonly message: string;
  readonly workflowKey?: string | undefined;
  readonly knownWorkflowKeys?: readonly string[] | undefined;
  readonly workflowRunId?: number | undefined;
  readonly worktreeId?: number | undefined;
  readonly surfaceId?: number | undefined;
  readonly paneId?: number | undefined;
}> {}

export function waitKind(condition: WorkflowWaitCondition): WorkflowWaitKind {
  return condition.kind;
}
