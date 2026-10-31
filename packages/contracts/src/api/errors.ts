import { Schema } from 'effect';

import { editorAttemptFailureReasonSchema } from '../editor/types.js';
import { positiveInteger } from '../scalars.js';
import { harnessLaunchBlockReasonSchema } from '../surfaces/types.js';
import {
  workflowStructureDiagnosticSchema,
  workflowLoadFailureReasonSchema,
} from '../workflows/types.js';
import { worktreeDestinationIssueSchema } from '../worktrees/types.js';
import { apiInfrastructureErrorSchema } from './responses.js';

/** The fields every error envelope carries beside its code, status and data. */
const errorEnvelopeFields = { message: Schema.String, requestId: Schema.String } as const;

export const projectPathRejectionReasonSchema = Schema.Literals([
  'path_not_found',
  'not_directory',
  'not_git_repository',
  'not_repository_root',
  'linked_worktree_checkout',
  // Unsupported Git layout: there is no working tree to open.
  'bare_repository',
  // The git executable could not be launched at all.
  'git_unavailable',
  // Git data exists at or above the path, but Git refuses to read it.
  'git_metadata_unreadable',
  // The path or one of its ancestors could not be inspected, so whether Git is
  // involved is unknown. Distinct from a negative answer on purpose.
  'git_metadata_indeterminate',
  'permission_denied',
  // Inconclusive probe: git ran and failed in a way that cannot be interpreted.
  'git_command_failed',
]);

export const workspaceActiveContextRejectionReasonSchema = Schema.Literals([
  'project_not_found',
  'worktree_not_found',
  'project_not_present',
]);

export const projectPathRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('project_path_rejected'),
  status: Schema.Literal(400),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: projectPathRejectionReasonSchema,
    path: Schema.String,
  }),
});

export const workspaceActiveContextRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('workspace_active_context_rejected'),
  status: Schema.Literal(400),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: workspaceActiveContextRejectionReasonSchema,
    projectId: Schema.optional(positiveInteger),
    worktreeId: Schema.optional(positiveInteger),
  }),
});

export const workspaceReconcileRejectionReasonSchema = Schema.Literals([
  'project_not_found',
  'command_cleanup_failed',
]);

/** A one-member reason set: `Literals` keeps `.literals` like every other reason schema. */
export const projectOperationRejectionReasonSchema = Schema.Literals(['command_cleanup_failed']);

export const editorRejectionReasonSchema = Schema.Literals([
  'worktree_not_found',
  'editor_context_not_found',
  // Provisioning has not reached `ready`.
  'editor_unavailable',
  // A retry arrived while one was already running.
  'editor_provisioning_busy',
  // The incarnation a read named is no longer the context's current one.
  'editor_incarnation_superseded',
]);

export const surfaceRejectionReasonSchema = Schema.Literals([
  'surface_not_found',
  'pane_not_found',
  'worktree_not_found',
  'session_not_found',
  'session_worktree_mismatch',
  // An automatic re-attach claimed a process incarnation the session no longer runs.
  'process_incarnation_stale',
  // An automatic re-attach found another attachment already streaming that process.
  'session_already_attached',
  'invalid_surface_title',
  'layout_node_stale',
  // Starting a surface's first pane when it already has panes.
  'surface_not_empty',
]);

export const worktreeEnvironmentFocusRejectionReasonSchema = Schema.Literals([
  'worktree_not_found',
  'surface_not_found',
  'pane_not_found',
]);

export const sessionLaunchRejectionReasonSchema = Schema.Union([
  Schema.Literal('worktree_not_found'),
  harnessLaunchBlockReasonSchema,
]);

export const worktreeCommandsRejectionReasonSchema = Schema.Literals([
  'worktree_not_found',
  'command_config_invalid',
  'command_not_found',
  'command_action_failed',
]);

export const projectRelocationRejectionReasonSchema = Schema.Literals([
  'project_not_found',
  'project_not_missing',
  'project_path_already_registered',
  // A folder project's path is fixed: its kind is immutable, and a replacement
  // path would need a policy for Git-bearing directories that this story does
  // not define. Recovery is restoring the directory where it was registered.
  'relocation_not_supported',
  'command_cleanup_failed',
]);

export const worktreeOperationRejectionReasonSchema = Schema.Literals([
  'project_not_found',
  'project_not_present',
  'branch_not_found',
  'new_branch_requires_base',
  'invalid_branch_name',
  'base_ref_not_found',
  'checkout_path_exists',
  'checkout_path_registered',
  'checkout_parent_unavailable',
  'worktree_not_found',
  'setup_config_invalid',
  'setup_trust_required',
  'setup_trust_mismatch',
  /**
   * The project maintains its own single environment, so there are no checkouts
   * to manage. Spelled as what is refused rather than which kind was seen, so a
   * future third project kind reuses it without a rename, and it reads correctly
   * in each of the four management families that carry it.
   */
  'worktrees_not_supported',
  /**
   * `openWorktreeInput.mode: 'create_new'` was asked to create something that already exists. Both
   * are unreachable under the default `open` mode, which adopts instead of refusing.
   */
  'branch_exists',
  'worktree_exists',
  'command_cleanup_failed',
]);

export const worktreeSetupRejectionReasonSchema = Schema.Literals([
  'project_not_found',
  'project_not_present',
  'setup_not_configured',
  'setup_config_invalid',
  'setup_trust_mismatch',
  // See `worktreeOperationRejectionReasonSchema`.
  'worktrees_not_supported',
]);

export const worktreeDeleteRejectionReasonSchema = Schema.Literals([
  'project_not_found',
  'project_not_present',
  'worktree_not_found',
  'root_worktree_not_deletable',
  'dirty_checkout_requires_force',
  'root_worktree_not_found',
  // See `worktreeOperationRejectionReasonSchema`.
  'worktrees_not_supported',
  'command_cleanup_failed',
  'pty_teardown_failed',
]);

export const projectDeleteRejectionReasonSchema = Schema.Literals([
  'command_cleanup_failed',
  'pty_teardown_failed',
]);

/**
 * Sibling reorder rejections. Each scope has its own disjoint reason set because
 * the legal sibling list differs: present projects, a project's non-root
 * worktrees, and one worktree's surfaces. A `before_*` reason always describes
 * the anchor, never the moved item.
 */
export const projectOrderRejectionReasonSchema = Schema.Literals([
  'project_not_found',
  'project_not_present',
  'before_project_not_found',
  'before_project_not_present',
]);

export const worktreeOrderRejectionReasonSchema = Schema.Literals([
  'project_not_found',
  'project_not_present',
  'worktree_not_found',
  'worktree_project_mismatch',
  'root_worktree_fixed',
  'before_worktree_not_found',
  'before_worktree_project_mismatch',
  'before_root_worktree_fixed',
  // See `worktreeOperationRejectionReasonSchema`.
  'worktrees_not_supported',
]);

export const surfaceOrderRejectionReasonSchema = Schema.Literals([
  'worktree_not_found',
  'surface_not_found',
  'surface_worktree_mismatch',
  'before_surface_not_found',
  'before_surface_worktree_mismatch',
]);

export const worktreeBranchListRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('worktree_branch_list_rejected'),
  status: Schema.Literal(400),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: worktreeOperationRejectionReasonSchema,
    projectId: Schema.optional(positiveInteger),
  }),
});

export const worktreeOpenRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('worktree_open_rejected'),
  status: Schema.Literals([400, 409, 500]),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: worktreeOperationRejectionReasonSchema,
    projectId: Schema.optional(positiveInteger),
    worktreeId: Schema.optional(positiveInteger),
    branch: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
  }),
});

export const worktreeSetupRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('worktree_setup_rejected'),
  status: Schema.Literal(400),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: worktreeSetupRejectionReasonSchema,
    projectId: Schema.optional(positiveInteger),
    hash: Schema.optional(Schema.String),
  }),
});

export const worktreeDeleteRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('worktree_delete_rejected'),
  status: Schema.Literal(400),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: worktreeDeleteRejectionReasonSchema,
    projectId: Schema.optional(positiveInteger),
    worktreeId: Schema.optional(positiveInteger),
    path: Schema.optional(Schema.String),
  }),
});

export const workspaceReconcileRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('workspace_reconcile_rejected'),
  status: Schema.Literal(400),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: workspaceReconcileRejectionReasonSchema,
    projectId: positiveInteger,
  }),
});

export const projectOperationRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('project_operation_rejected'),
  status: Schema.Literal(400),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: projectOperationRejectionReasonSchema,
    projectId: Schema.optional(positiveInteger),
    worktreeId: Schema.optional(positiveInteger),
  }),
});

export const projectDeleteRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('project_delete_rejected'),
  status: Schema.Literal(400),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: projectDeleteRejectionReasonSchema,
    projectId: Schema.optional(positiveInteger),
    worktreeId: Schema.optional(positiveInteger),
  }),
});

// The source identifiers are required because they come from the route and are
// therefore always known; the anchor is optional because a `null` anchor cannot
// be the thing that failed.
export const projectOrderRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('project_order_rejected'),
  status: Schema.Literal(400),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: projectOrderRejectionReasonSchema,
    projectId: positiveInteger,
    beforeProjectId: Schema.optional(positiveInteger),
  }),
});

export const worktreeOrderRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('worktree_order_rejected'),
  status: Schema.Literal(400),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: worktreeOrderRejectionReasonSchema,
    projectId: positiveInteger,
    worktreeId: positiveInteger,
    beforeWorktreeId: Schema.optional(positiveInteger),
  }),
});

export const surfaceOrderRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('surface_order_rejected'),
  status: Schema.Literal(400),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: surfaceOrderRejectionReasonSchema,
    worktreeId: positiveInteger,
    surfaceId: positiveInteger,
    beforeSurfaceId: Schema.optional(positiveInteger),
  }),
});

export const surfaceRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('surface_rejected'),
  status: Schema.Literal(400),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: surfaceRejectionReasonSchema,
    worktreeId: Schema.optional(positiveInteger),
    surfaceId: Schema.optional(positiveInteger),
    paneId: Schema.optional(positiveInteger),
    sessionId: Schema.optional(positiveInteger),
  }),
});

export const worktreeEnvironmentFocusRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('worktree_environment_focus_rejected'),
  status: Schema.Literal(400),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: worktreeEnvironmentFocusRejectionReasonSchema,
    worktreeId: Schema.optional(positiveInteger),
    surfaceId: Schema.optional(positiveInteger),
    paneId: Schema.optional(positiveInteger),
    agentSessionId: Schema.optional(positiveInteger),
  }),
});

export const sessionLaunchRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('session_launch_rejected'),
  status: Schema.Literal(400),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: sessionLaunchRejectionReasonSchema,
    worktreeId: Schema.optional(positiveInteger),
    diagnostic: Schema.optional(Schema.String),
  }),
});

export const worktreeCommandsRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('worktree_commands_rejected'),
  // 400 for validation/not-found reasons the caller can fix; 500 for
  // `command_action_failed`, which is a degraded-runtime failure (e.g. a PTY
  // termination that did not go through), not a rejected request.
  status: Schema.Literals([400, 500]),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: worktreeCommandsRejectionReasonSchema,
    worktreeId: Schema.optional(positiveInteger),
    commandName: Schema.optional(Schema.String),
  }),
});

/**
 * Context any workflow rejection may carry. Reason-specific *required* context is added by the
 * variants below rather than being optional here, because a caller that must render a structural
 * rejection or an unusable export destination cannot do so from a reason alone.
 */
const workflowRejectionContextFields = {
  workflowKey: Schema.optional(Schema.String),
  workflowRunId: Schema.optional(positiveInteger),
  /** The run already attached to the surface, for `workflow_surface_busy`. */
  activeWorkflowRunId: Schema.optional(positiveInteger),
  worktreeId: Schema.optional(positiveInteger),
  surfaceId: Schema.optional(positiveInteger),
  paneId: Schema.optional(positiveInteger),
  agentSessionId: Schema.optional(positiveInteger),
  executionId: Schema.optional(positiveInteger),
  operationId: Schema.optional(positiveInteger),
  checkpointId: Schema.optional(positiveInteger),
  /** A checkpoint file path, for `workflow_checkpoint_file_not_found`. */
  path: Schema.optional(Schema.String),
  /** The control that was refused, for `workflow_control_unavailable`. */
  control: Schema.optional(
    Schema.Literals(['pause', 'resume', 'retry', 'cancel', 'dismiss', 'advance']),
  ),
  workflowLoadFailureReason: Schema.optional(workflowLoadFailureReasonSchema),
  workflowSourceDirectory: Schema.optional(Schema.String),
  workflowPackageDirectory: Schema.optional(Schema.String),
  shadowedWorkflowPackageDirectories: Schema.optional(Schema.Array(Schema.String)),
  /** Which way a placement is unusable, for `workflow_placement_invalid`. */
  placementIssue: Schema.optional(
    Schema.Literals([
      'surface_not_on_worktree',
      'worktree_not_in_project',
      'invalid_surface_title',
      'no_current_surface',
    ]),
  ),
  /** What already exists, for `workflow_environment_collision`. */
  collision: Schema.optional(Schema.Literals(['branch', 'worktree', 'checkout_path'])),
  /** The branch a launch asked to create, for the branch and collision reasons. */
  branch: Schema.optional(Schema.String),
  /** The ref that could not be resolved, for `workflow_base_ref_not_found`. */
  baseRef: Schema.optional(Schema.String),
  /** The launch project, or the project a checkpoint export needs. */
  projectId: Schema.optional(positiveInteger),
  /** The commit a checkpoint names, for `workflow_checkpoint_commit_unavailable`. */
  commitSha: Schema.optional(Schema.String),
} as const;

/** The reasons whose context is mandatory; each has its own data variant below. */
const workflowContextualRejectionReasonSchema = Schema.Literals([
  /** A workflow build failed structural verification. */
  'workflow_structure_validation_failed',
  /**
   * Resume or Retry was refused because the latest build no longer fits where the run is parked:
   * a graph, subgraph link or parked node is gone or changed kind. The run is unchanged.
   */
  'workflow_code_incompatible',
  /** The folder named for a checkpoint export cannot hold one. See `destinationIssue`. */
  'workflow_checkpoint_destination_rejected',
]);

/** Reasons that carry no mandatory context of their own. */
const workflowPlainRejectionReasonSchema = Schema.Literals([
  'unknown_workflow_key',
  'workflow_discovery_failed',
  'workflow_load_failed',
  'worktree_not_found',
  'surface_not_found',
  'surface_worktree_mismatch',
  'pane_not_found',
  'agent_session_not_on_surface',
  'workflow_launch_context_mismatch',
  'workflow_command_failed',
  /** The workflow's `parse` threw. The message is the author's, verbatim. */
  'workflow_parse_rejected',
  /** The workflow's `parse` returned parameters that cannot be stored. The message names the path. */
  'workflow_parameters_invalid',
  /** A surface holds at most one attached run. See `activeWorkflowRunId`. */
  'workflow_surface_busy',
  'workflow_run_not_found',
  'workflow_execution_not_found',
  'workflow_operation_not_found',
  'workflow_checkpoint_not_found',
  'workflow_checkpoint_file_not_found',
  /** The run's status does not allow this control right now. See `control`. */
  'workflow_control_unavailable',
  /** `advance` named an execution that is not waiting on the user. */
  'workflow_wait_not_found',
  'workflow_user_input_invalid',
  /** Retry could not refresh the agent session's turns to re-check its wait. */
  'workflow_agent_observation_unavailable',
  /** The workflow's `placement` hook threw, or returned a value the placement schema refuses. */
  'workflow_placement_failed',
  /** The requested placement does not describe a usable destination. See `placementIssue`. */
  'workflow_placement_invalid',
  /** A folder project maintains its own single environment, so it has no worktrees to create. */
  'workflow_worktree_creation_unsupported',
  'workflow_branch_invalid',
  'workflow_base_ref_not_found',
  /**
   * Something already occupies what the launch asked to create. 409 rather than 400: the request is
   * well-formed and would succeed against a different live state. See `collision`.
   */
  'workflow_environment_collision',
  /** Preparing the run's worktree or surface failed. The run records what was created. */
  'workflow_preparation_failed',
  /**
   * A Git checkpoint's base cannot be used: its project is gone or no longer a Git repository, or
   * its commit no longer exists (a squashed or discarded commit, a known limitation). The message
   * says which.
   */
  'workflow_checkpoint_commit_unavailable',
  /** A checkpoint's saved bytes could not be read. */
  'workflow_checkpoint_content_unavailable',
  /**
   * Creating the export worktree or writing its files failed after something was created. Nothing
   * is cleaned up; the message names the step, the path and whether the destination has content,
   * and `worktreeId` is set when a worktree was registered.
   */
  'workflow_checkpoint_export_failed',
]);

/**
 * Every expected workflow failure a client is meant to handle. Derived from the two sets the data
 * variants use, so a reason can never be advertised here while `workflowRejectedErrorSchema`
 * rejects it.
 */
export const workflowRejectionReasonSchema = Schema.Union([
  workflowPlainRejectionReasonSchema,
  workflowContextualRejectionReasonSchema,
]);

/**
 * The rejection payload, discriminated by reason so the reasons with mandatory context cannot be
 * sent without it.
 */
export const workflowRejectionDataSchema = Schema.Union([
  Schema.Struct({
    ...workflowRejectionContextFields,
    reason: Schema.Literals(['workflow_structure_validation_failed', 'workflow_code_incompatible']),
    /** Which registrations are wrong. Addressable records, never one free-text sentence. */
    diagnostics: Schema.Array(workflowStructureDiagnosticSchema),
  }),
  Schema.Struct({
    ...workflowRejectionContextFields,
    reason: Schema.Literal('workflow_checkpoint_destination_rejected'),
    /** The path as the runtime judged it: canonical when it got that far, otherwise as given. */
    destinationPath: Schema.String.check(Schema.isMinLength(1)),
    destinationIssue: worktreeDestinationIssueSchema,
  }),
  Schema.Struct({
    ...workflowRejectionContextFields,
    reason: workflowPlainRejectionReasonSchema,
  }),
]);

export const workflowRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('workflow_rejected'),
  status: Schema.Literals([400, 409, 500]),
  ...errorEnvelopeFields,
  data: workflowRejectionDataSchema,
});

export const projectRelocationRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('project_relocation_rejected'),
  status: Schema.Literals([400, 409]),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: projectRelocationRejectionReasonSchema,
    projectId: positiveInteger,
    path: Schema.optional(Schema.String),
    conflictingProjectId: Schema.optional(positiveInteger),
  }),
});

export const gitCommandFailedErrorSchema = Schema.Struct({
  code: Schema.Literal('git_command_failed'),
  status: Schema.Literal(500),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    args: Schema.Array(Schema.String),
    cwd: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

export const runtimeDatabaseFailedErrorSchema = Schema.Struct({
  code: Schema.Literal('runtime_database_failed'),
  status: Schema.Literal(500),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    operation: Schema.String,
  }),
});

export const runtimeStateFileFailedErrorSchema = Schema.Struct({
  code: Schema.Literal('runtime_state_file_failed'),
  status: Schema.Literal(500),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    operation: Schema.String,
  }),
});

export const runtimeDataDirectoryFailedErrorSchema = Schema.Struct({
  code: Schema.Literal('runtime_data_directory_failed'),
  status: Schema.Literal(500),
  ...errorEnvelopeFields,
});

/** The two storage failures almost every persisting endpoint can report, always last in its union. */
const storageFailures = [
  runtimeDatabaseFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
] as const;

export const workspaceGetApiErrorSchema = Schema.Union([
  gitCommandFailedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeStateFileFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
]);

export const workspaceActiveContextApiErrorSchema = Schema.Union([
  workspaceActiveContextRejectedErrorSchema,
  gitCommandFailedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeStateFileFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
]);

export const workspaceReconcileApiErrorSchema = Schema.Union([
  workspaceReconcileRejectedErrorSchema,
  gitCommandFailedErrorSchema,
  ...storageFailures,
]);

/**
 * The surfaces routes' failures. A pane-session route (create, split, start, create/claim session)
 * can also be refused by the harness launch gate, which every client reads as
 * `session_launch_rejected`.
 */
export const surfaceApiErrorSchema = Schema.Union([
  surfaceRejectedErrorSchema,
  sessionLaunchRejectedErrorSchema,
  ...storageFailures,
]);

/**
 * Request-boundary refusals: the operation was not attempted. Presented by the
 * caller that made the request, never folded into the editor's own projection.
 */
export const editorRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('editor_rejected'),
  status: Schema.Literal(400),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: editorRejectionReasonSchema,
    worktreeId: Schema.optional(positiveInteger),
    editorContextId: Schema.optional(positiveInteger),
    diagnostic: Schema.optional(Schema.String),
  }),
});

/**
 * The attempt ran, was persisted on the context, and failed. The request is
 * well-formed and the target is valid, so this is not a 400; the caller's
 * correct response is to re-read the context, so it is a 409. The reason is the
 * same union the durable attempt record carries, which is what keeps the wire
 * and the row from drifting.
 */
export const editorLaunchFailedErrorSchema = Schema.Struct({
  code: Schema.Literal('editor_launch_failed'),
  status: Schema.Literal(409),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: editorAttemptFailureReasonSchema,
    editorContextId: positiveInteger,
    detail: Schema.optional(Schema.String),
  }),
});

/**
 * The startup output exists but could not be read. Deliberately not folded into
 * a successful empty excerpt: "there is nothing to show" and "we could not look"
 * are different answers, and only one of them is worth a retry.
 */
export const editorDiagnosticsUnavailableErrorSchema = Schema.Struct({
  code: Schema.Literal('editor_diagnostics_unavailable'),
  status: Schema.Literal(500),
  ...errorEnvelopeFields,
  data: Schema.Struct({ detail: Schema.String }),
});

/**
 * One union serves all four editor endpoints, the way `surfaceApiErrorSchema`
 * already serves the surfaces routes. It must cover its mapper exactly: the
 * route helper validates every error whose code does not begin with `api_`
 * against the endpoint's schema, and a miss reaches the client as an encoding
 * failure — turning a diagnosable fault into an undiagnosable one. Opening an
 * editor composes a surfaces operation, so a surfaces rejection can reach this
 * boundary and is composed rather than re-spelled.
 */
export const editorApiErrorSchema = Schema.Union([
  apiInfrastructureErrorSchema,
  editorRejectedErrorSchema,
  editorLaunchFailedErrorSchema,
  editorDiagnosticsUnavailableErrorSchema,
  surfaceRejectedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
]);

export const worktreeEnvironmentFocusApiErrorSchema = Schema.Union([
  worktreeEnvironmentFocusRejectedErrorSchema,
  ...storageFailures,
]);

export const sessionLaunchApiErrorSchema = Schema.Union([
  sessionLaunchRejectedErrorSchema,
  ...storageFailures,
]);

export const worktreeCommandsApiErrorSchema = Schema.Union([
  worktreeCommandsRejectedErrorSchema,
  ...storageFailures,
]);

/**
 * Launching a run can fail the way any project-touching endpoint can.
 *
 * Beyond `workflow_rejected`, the launch path makes one owning-service call — the worktree-creation
 * preflight — so Git, the state file, a project path and project configuration can all fail
 * underneath it. Those are infrastructure rather than a placement the caller chose badly, and they
 * are reported as themselves so a client can tell "fix your request" from "something broke
 * underneath it". They must be declared here or the response encoder refuses them and the caller
 * receives `api_response_encoding_failed` instead of the diagnosable failure.
 */
const workflowApiErrorUnion = Schema.Union([
  workflowRejectedErrorSchema,
  projectPathRejectedErrorSchema,
  worktreeSetupRejectedErrorSchema,
  gitCommandFailedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeStateFileFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
]);

/**
 * Named rather than inferred. Every workflow endpoint carries this schema, and declaration emit
 * would otherwise spell out the whole union at each one, which exceeds what the compiler will
 * serialize for `workflowsEndpoints`.
 */
export interface WorkflowApiErrorSchema extends Schema.Codec<
  typeof workflowApiErrorUnion.Type,
  typeof workflowApiErrorUnion.Encoded
> {}

export const workflowApiErrorSchema: WorkflowApiErrorSchema = workflowApiErrorUnion;

export const projectApiErrorSchema = Schema.Union([
  projectOperationRejectedErrorSchema,
  projectPathRejectedErrorSchema,
  gitCommandFailedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeStateFileFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
]);

export const projectRelocateApiErrorSchema = Schema.Union([
  projectRelocationRejectedErrorSchema,
  projectPathRejectedErrorSchema,
  gitCommandFailedErrorSchema,
  ...storageFailures,
]);

export const projectDeleteApiErrorSchema = Schema.Union([
  projectDeleteRejectedErrorSchema,
  ...storageFailures,
]);

export const projectOrderApiErrorSchema = Schema.Union([
  projectOrderRejectedErrorSchema,
  ...storageFailures,
]);

export const worktreeOrderApiErrorSchema = Schema.Union([
  worktreeOrderRejectedErrorSchema,
  ...storageFailures,
]);

export const surfaceOrderApiErrorSchema = Schema.Union([
  surfaceOrderRejectedErrorSchema,
  ...storageFailures,
]);

export const worktreeBranchListApiErrorSchema = Schema.Union([
  worktreeBranchListRejectedErrorSchema,
  gitCommandFailedErrorSchema,
  ...storageFailures,
]);

export const worktreeOpenApiErrorSchema = Schema.Union([
  worktreeOpenRejectedErrorSchema,
  gitCommandFailedErrorSchema,
  ...storageFailures,
]);

export const worktreeSetupApiErrorSchema = Schema.Union([
  worktreeSetupRejectedErrorSchema,
  ...storageFailures,
]);

export const worktreeDeleteApiErrorSchema = Schema.Union([
  worktreeDeleteRejectedErrorSchema,
  gitCommandFailedErrorSchema,
  ...storageFailures,
]);

export type ProjectPathRejectionReason = typeof projectPathRejectionReasonSchema.Type;
export type WorkspaceActiveContextRejectionReason =
  typeof workspaceActiveContextRejectionReasonSchema.Type;
export type WorkspaceReconcileRejectionReason = typeof workspaceReconcileRejectionReasonSchema.Type;
export type SurfaceRejectionReason = typeof surfaceRejectionReasonSchema.Type;
export type EditorRejectionReason = typeof editorRejectionReasonSchema.Type;
export type WorktreeEnvironmentFocusRejectionReason =
  typeof worktreeEnvironmentFocusRejectionReasonSchema.Type;
export type SessionLaunchRejectionReason = typeof sessionLaunchRejectionReasonSchema.Type;
export type WorktreeCommandsRejectionReason = typeof worktreeCommandsRejectionReasonSchema.Type;
export type WorkflowRejectionReason = typeof workflowRejectionReasonSchema.Type;
export type WorkflowRejectionData = typeof workflowRejectionDataSchema.Type;
export type ProjectRelocationRejectionReason = typeof projectRelocationRejectionReasonSchema.Type;
export type ProjectOperationRejectionReason = typeof projectOperationRejectionReasonSchema.Type;
export type ProjectDeleteRejectionReason = typeof projectDeleteRejectionReasonSchema.Type;
export type WorktreeOperationRejectionReason = typeof worktreeOperationRejectionReasonSchema.Type;
export type WorktreeSetupRejectionReason = typeof worktreeSetupRejectionReasonSchema.Type;
export type WorktreeDeleteRejectionReason = typeof worktreeDeleteRejectionReasonSchema.Type;
export type ProjectOrderRejectionReason = typeof projectOrderRejectionReasonSchema.Type;
export type WorktreeOrderRejectionReason = typeof worktreeOrderRejectionReasonSchema.Type;
export type SurfaceOrderRejectionReason = typeof surfaceOrderRejectionReasonSchema.Type;
export type ProjectOrderRejectedError = typeof projectOrderRejectedErrorSchema.Type;
export type WorktreeOrderRejectedError = typeof worktreeOrderRejectedErrorSchema.Type;
export type SurfaceOrderRejectedError = typeof surfaceOrderRejectedErrorSchema.Type;
export type ProjectPathRejectedError = typeof projectPathRejectedErrorSchema.Type;
export type WorkspaceActiveContextRejectedError =
  typeof workspaceActiveContextRejectedErrorSchema.Type;
export type WorkspaceReconcileRejectedError = typeof workspaceReconcileRejectedErrorSchema.Type;
export type SurfaceRejectedError = typeof surfaceRejectedErrorSchema.Type;
export type EditorRejectedError = typeof editorRejectedErrorSchema.Type;
export type EditorLaunchFailedError = typeof editorLaunchFailedErrorSchema.Type;
export type EditorDiagnosticsUnavailableError = typeof editorDiagnosticsUnavailableErrorSchema.Type;
export type WorktreeEnvironmentFocusRejectedError =
  typeof worktreeEnvironmentFocusRejectedErrorSchema.Type;
export type SessionLaunchRejectedError = typeof sessionLaunchRejectedErrorSchema.Type;
export type WorktreeCommandsRejectedError = typeof worktreeCommandsRejectedErrorSchema.Type;
export type ProjectRelocationRejectedError = typeof projectRelocationRejectedErrorSchema.Type;
export type ProjectOperationRejectedError = typeof projectOperationRejectedErrorSchema.Type;
export type ProjectDeleteRejectedError = typeof projectDeleteRejectedErrorSchema.Type;
export type WorktreeBranchListRejectedError = typeof worktreeBranchListRejectedErrorSchema.Type;
export type WorktreeOpenRejectedError = typeof worktreeOpenRejectedErrorSchema.Type;
export type WorktreeSetupRejectedError = typeof worktreeSetupRejectedErrorSchema.Type;
export type WorktreeDeleteRejectedError = typeof worktreeDeleteRejectedErrorSchema.Type;
