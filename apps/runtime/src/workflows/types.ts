import { Data } from 'effect';

import type { WorkflowWaitCondition, WorkflowWaitKind } from '@isagi/workflow-sdk';

import type { DatabaseError, StateFileError } from '../persistence/index.js';

export type {
  WorkflowAgentHarness,
  WorkflowContext,
  WorkflowConversationMessage,
  WorkflowConversationPart,
  WorkflowConversationRole,
  WorkflowDefinition,
  WorkflowQuestionOption,
  WorkflowQuestionSpec,
  WorkflowResult,
  WorkflowStep,
  WorkflowUiFeedback,
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

export type WorkflowEngineServiceError = WorkflowEngineError | DatabaseError | StateFileError;

export class WorkflowEngineError extends Data.TaggedError('WorkflowEngineError')<{
  readonly code:
    | 'unknown_workflow_key'
    | 'no_active_worktree'
    | 'workflow_run_not_found'
    | 'workflow_run_not_paused';
  readonly message: string;
  readonly workflowKey?: string | undefined;
  readonly knownWorkflowKeys?: readonly string[] | undefined;
  readonly workflowRunId?: number | undefined;
}> {}

export function waitKind(condition: WorkflowWaitCondition): WorkflowWaitKind {
  return condition.kind;
}
