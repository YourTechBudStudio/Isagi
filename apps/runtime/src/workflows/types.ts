import { Data } from 'effect';

import type { DatabaseError } from '../persistence/index.js';

export type WorkflowStatus = 'paused' | 'waiting' | 'ready' | 'running' | 'done' | 'failed';

export type WorkflowWaitKind =
  | 'turn'
  | 'user_continue'
  | 'user_input'
  | 'child_workflow'
  | 'headless';

export type WorkflowWaitCondition =
  | {
      readonly kind: 'turn';
      readonly agentSessionId: number;
      readonly harnessSessionId: string;
      readonly afterT: string;
    }
  | { readonly kind: 'user_continue' }
  | { readonly kind: 'user_input' }
  | { readonly kind: 'child_workflow'; readonly runId: number }
  | { readonly kind: 'headless'; readonly opId: string };

export type WorkflowResult =
  | { readonly type: 'cont'; readonly state: unknown }
  | { readonly type: 'suspend'; readonly state: unknown; readonly condition: WorkflowWaitCondition }
  | { readonly type: 'done' };

export interface WorkflowContext {
  readonly setUiFeedback: (feedback: WorkflowUiFeedback) => Promise<void>;
}

export interface WorkflowUiFeedback {
  readonly phase?: string | undefined;
  readonly message?: string | undefined;
}

export type WorkflowStep = (
  ctx: WorkflowContext,
  state: unknown,
  event?: unknown,
) => Promise<WorkflowResult>;

export interface WorkflowDefinition {
  readonly initialState: unknown;
  readonly step: WorkflowStep;
}

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
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type WorkflowEngineServiceError = WorkflowEngineError | DatabaseError;

export class WorkflowEngineError extends Data.TaggedError('WorkflowEngineError')<{
  readonly code: 'unknown_workflow_key';
  readonly message: string;
  readonly workflowKey: string;
  readonly knownWorkflowKeys: readonly string[];
}> {}

export function waitKind(condition: WorkflowWaitCondition): WorkflowWaitKind {
  return condition.kind;
}
