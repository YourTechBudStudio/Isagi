import { Data } from 'effect';

import type { DatabaseError } from '../persistence/index.js';

/**
 * The authoring contract, re-exported for runtime code.
 *
 * These are the *author's* types. The runtime almost never sees them fully applied: a bundle is
 * compiled against its own copy of the SDK, so by the time a definition reaches the loader its real
 * state, parameter and output types are gone. Structural recognition establishes the shape instead,
 * which is why the loader works in terms of the `Any…` aliases it declares rather than these.
 */
export type {
  AgentSessionHandle,
  AgentTurnEvent,
  EdgeDecision,
  GraphDefinition,
  GraphEdge,
  GraphNode,
  GraphOutcome,
  GraphUpdate,
  HeadlessOperationHandle,
  HeadlessOperationResult,
  NodeEvent,
  OperationContext,
  OperationNode,
  OperationResult,
  StateField,
  SubgraphNode,
  SubgraphResult,
  WaitDeclaration,
  WorkflowAgentHarness,
  WorkflowCommandManifest,
  WorkflowConversationMessage,
  WorkflowConversationPart,
  WorkflowConversationRole,
  WorkflowDefinition,
  WorkflowDestination,
  WorkflowEdgeId,
  WorkflowGraphKey,
  WorkflowInputs,
  WorkflowNodeId,
  WorkflowOrigin,
  WorkflowOutcomeId,
  WorkflowQuestionOption,
  WorkflowQuestionSpec,
  WorkflowUiFeedback,
  WorkflowUserInputAnswers,
  WorkflowWaitKind,
} from '@yourtechbudstudio/isagi-workflow-sdk';

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
    | 'workflow_run_not_found'
    | 'workflow_surface_busy'
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
