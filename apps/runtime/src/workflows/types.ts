import type { StructureDiagnostic } from '@yourtechbudstudio/isagi-workflow-verifier/structure';
import { Data } from 'effect';

import type { WorkflowLoadFailureReason, WorkflowRejectionReason } from '@isagi/contracts';

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
  GraphStateFields,
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

/**
 * An expected engine failure, named with the same vocabulary the wire uses.
 *
 * `code` is deliberately the contract's `WorkflowRejectionReason` rather than a private enum. The
 * engine is where these decisions are actually made, and keeping one vocabulary means the API layer
 * maps identities and context — never renames a reason, and never has to invent one for a case the
 * engine already distinguishes.
 */
export class WorkflowEngineError extends Data.TaggedError('WorkflowEngineError')<{
  readonly code: WorkflowRejectionReason;
  readonly message: string;
  readonly workflowKey?: string | undefined;
  readonly workflowLoadFailureReason?: WorkflowLoadFailureReason | undefined;
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
  /** The pin a caller asked about, for a version that was never adopted. */
  readonly artifactHash?: string | undefined;
  /** The operation holding a blocked run, for `workflow_operation_uncertain`. */
  readonly operationKey?: string | undefined;
  /** Which registrations no longer fit, for `workflow_structure_validation_failed`. */
  readonly diagnostics?: readonly StructureDiagnostic[] | undefined;
  /** Which recorded value could not be served, for `workflow_payload_unavailable`. */
  readonly payloadRef?: string | undefined;
  readonly payloadCause?: 'missing' | 'corrupt' | undefined;
}> {}
