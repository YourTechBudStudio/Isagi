import { Schema } from 'effect';

import { editorAttemptFailureReasonSchema } from '../editor/types.js';
import { harnessLaunchBlockReasonSchema } from '../surfaces/types.js';
import {
  workflowStructureDiagnosticSchema,
  workflowLoadFailureReasonSchema,
} from '../workflows/types.js';
import { worktreeDestinationIssueSchema } from '../worktrees/types.js';
import { apiInfrastructureErrorSchema } from './responses.js';

export const projectPathRejectionReasonSchema = Schema.Literal(
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
);

export const workspaceActiveContextRejectionReasonSchema = Schema.Literal(
  'project_not_found',
  'worktree_not_found',
  'project_not_present',
);

export const projectPathRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('project_path_rejected'),
  status: Schema.Literal(400),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: projectPathRejectionReasonSchema,
    path: Schema.String,
  }),
});

export const workspaceActiveContextRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('workspace_active_context_rejected'),
  status: Schema.Literal(400),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: workspaceActiveContextRejectionReasonSchema,
    projectId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
    worktreeId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  }),
});

export const workspaceReconcileRejectionReasonSchema = Schema.Literal(
  'project_not_found',
  'command_cleanup_failed',
);

export const projectOperationRejectionReasonSchema = Schema.Literal('command_cleanup_failed');

export const editorRejectionReasonSchema = Schema.Literal(
  'worktree_not_found',
  'editor_context_not_found',
  // This runtime declares no editor capability.
  'editor_unsupported_runtime',
  // Provisioning has not reached `ready`.
  'editor_unavailable',
  // A retry arrived while one was already running.
  'editor_provisioning_busy',
  // The incarnation a read named is no longer the context's current one.
  'editor_incarnation_superseded',
);

export const surfaceRejectionReasonSchema = Schema.Literal(
  'surface_not_found',
  'pane_not_found',
  'worktree_not_found',
  'session_not_found',
  'session_worktree_mismatch',
  'invalid_surface_title',
  'layout_node_stale',
);

export const worktreeEnvironmentFocusRejectionReasonSchema = Schema.Literal(
  'worktree_not_found',
  'surface_not_found',
  'pane_not_found',
);

export const sessionLaunchRejectionReasonSchema = Schema.Union(
  Schema.Literal('worktree_not_found'),
  harnessLaunchBlockReasonSchema,
);

export const worktreeCommandsRejectionReasonSchema = Schema.Literal(
  'worktree_not_found',
  'command_config_invalid',
  'command_not_found',
  'command_action_failed',
);

export const projectRelocationRejectionReasonSchema = Schema.Literal(
  'project_not_found',
  'project_not_missing',
  'project_path_already_registered',
  // A folder project's path is fixed: its kind is immutable, and a replacement
  // path would need a policy for Git-bearing directories that this story does
  // not define. Recovery is restoring the directory where it was registered.
  'relocation_not_supported',
  'command_cleanup_failed',
);

export const worktreeOperationRejectionReasonSchema = Schema.Literal(
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
);

export const worktreeSetupRejectionReasonSchema = Schema.Literal(
  'project_not_found',
  'project_not_present',
  'setup_not_configured',
  'setup_config_invalid',
  'setup_trust_mismatch',
  // See `worktreeOperationRejectionReasonSchema`.
  'worktrees_not_supported',
);

export const worktreeDeleteRejectionReasonSchema = Schema.Literal(
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
);

export const projectDeleteRejectionReasonSchema = Schema.Literal('command_cleanup_failed');

/**
 * Sibling reorder rejections. Each scope has its own disjoint reason set because
 * the legal sibling list differs: present projects, a project's non-root
 * worktrees, and one worktree's surfaces. A `before_*` reason always describes
 * the anchor, never the moved item.
 */
export const projectOrderRejectionReasonSchema = Schema.Literal(
  'project_not_found',
  'project_not_present',
  'before_project_not_found',
  'before_project_not_present',
);

export const worktreeOrderRejectionReasonSchema = Schema.Literal(
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
);

export const surfaceOrderRejectionReasonSchema = Schema.Literal(
  'worktree_not_found',
  'surface_not_found',
  'surface_worktree_mismatch',
  'before_surface_not_found',
  'before_surface_worktree_mismatch',
);

export const worktreeBranchListRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('worktree_branch_list_rejected'),
  status: Schema.Literal(400),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: worktreeOperationRejectionReasonSchema,
    projectId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  }),
});

export const worktreeOpenRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('worktree_open_rejected'),
  status: Schema.Union(Schema.Literal(400), Schema.Literal(409), Schema.Literal(500)),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: worktreeOperationRejectionReasonSchema,
    projectId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
    worktreeId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
    branch: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
  }),
});

export const worktreeSetupRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('worktree_setup_rejected'),
  status: Schema.Literal(400),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: worktreeSetupRejectionReasonSchema,
    projectId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
    hash: Schema.optional(Schema.String),
  }),
});

export const worktreeDeleteRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('worktree_delete_rejected'),
  status: Schema.Literal(400),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: worktreeDeleteRejectionReasonSchema,
    projectId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
    worktreeId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
    path: Schema.optional(Schema.String),
  }),
});

export const workspaceReconcileRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('workspace_reconcile_rejected'),
  status: Schema.Literal(400),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: workspaceReconcileRejectionReasonSchema,
    projectId: Schema.Number.pipe(Schema.int(), Schema.positive()),
  }),
});

export const projectOperationRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('project_operation_rejected'),
  status: Schema.Literal(400),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: projectOperationRejectionReasonSchema,
    projectId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
    worktreeId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  }),
});

export const projectDeleteRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('project_delete_rejected'),
  status: Schema.Literal(400),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: projectDeleteRejectionReasonSchema,
    projectId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
    worktreeId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  }),
});

// The source identifiers are required because they come from the route and are
// therefore always known; the anchor is optional because a `null` anchor cannot
// be the thing that failed.
export const projectOrderRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('project_order_rejected'),
  status: Schema.Literal(400),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: projectOrderRejectionReasonSchema,
    projectId: Schema.Number.pipe(Schema.int(), Schema.positive()),
    beforeProjectId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  }),
});

export const worktreeOrderRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('worktree_order_rejected'),
  status: Schema.Literal(400),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: worktreeOrderRejectionReasonSchema,
    projectId: Schema.Number.pipe(Schema.int(), Schema.positive()),
    worktreeId: Schema.Number.pipe(Schema.int(), Schema.positive()),
    beforeWorktreeId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  }),
});

export const surfaceOrderRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('surface_order_rejected'),
  status: Schema.Literal(400),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: surfaceOrderRejectionReasonSchema,
    worktreeId: Schema.Number.pipe(Schema.int(), Schema.positive()),
    surfaceId: Schema.Number.pipe(Schema.int(), Schema.positive()),
    beforeSurfaceId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  }),
});

export const surfaceRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('surface_rejected'),
  status: Schema.Literal(400),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: surfaceRejectionReasonSchema,
    worktreeId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
    surfaceId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
    paneId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
    sessionId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  }),
});

export const worktreeEnvironmentFocusRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('worktree_environment_focus_rejected'),
  status: Schema.Literal(400),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: worktreeEnvironmentFocusRejectionReasonSchema,
    worktreeId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
    surfaceId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
    paneId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
    agentSessionId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  }),
});

export const sessionLaunchRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('session_launch_rejected'),
  status: Schema.Literal(400),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: sessionLaunchRejectionReasonSchema,
    worktreeId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
    diagnostic: Schema.optional(Schema.String),
  }),
});

export const worktreeCommandsRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('worktree_commands_rejected'),
  // 400 for validation/not-found reasons the caller can fix; 500 for
  // `command_action_failed`, which is a degraded-runtime failure (e.g. a PTY
  // termination that did not go through), not a rejected request.
  status: Schema.Union(Schema.Literal(400), Schema.Literal(500)),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: worktreeCommandsRejectionReasonSchema,
    worktreeId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
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
  workflowRunId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  /** The run already attached to the surface, for `workflow_surface_busy`. */
  activeWorkflowRunId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  worktreeId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  surfaceId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  paneId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  agentSessionId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  executionId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  operationId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  checkpointId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  /** A checkpoint file path, for `workflow_checkpoint_file_not_found`. */
  path: Schema.optional(Schema.String),
  /** The control that was refused, for `workflow_control_unavailable`. */
  control: Schema.optional(
    Schema.Literal('pause', 'resume', 'retry', 'cancel', 'dismiss', 'advance'),
  ),
  workflowLoadFailureReason: Schema.optional(workflowLoadFailureReasonSchema),
  workflowSourceDirectory: Schema.optional(Schema.String),
  workflowPackageDirectory: Schema.optional(Schema.String),
  shadowedWorkflowPackageDirectories: Schema.optional(Schema.Array(Schema.String)),
  /** Which way a placement is unusable, for `workflow_placement_invalid`. */
  placementIssue: Schema.optional(
    Schema.Literal('surface_not_on_worktree', 'worktree_not_in_project', 'invalid_surface_title'),
  ),
  /** What already exists, for `workflow_environment_collision`. */
  collision: Schema.optional(Schema.Literal('branch', 'worktree', 'checkout_path')),
  /** The branch a launch asked to create, for the branch and collision reasons. */
  branch: Schema.optional(Schema.String),
  /** The ref that could not be resolved, for `workflow_base_ref_not_found`. */
  baseRef: Schema.optional(Schema.String),
  /** The launch project, or the project a checkpoint export needs. */
  projectId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  /** The commit a checkpoint names, for `workflow_checkpoint_commit_unavailable`. */
  commitSha: Schema.optional(Schema.String),
} as const;

/** The reasons whose context is mandatory; each has its own data variant below. */
const workflowContextualRejectionReasonSchema = Schema.Literal(
  /** A workflow build failed structural verification. */
  'workflow_structure_validation_failed',
  /**
   * Resume or Retry was refused because the latest build no longer fits where the run is parked:
   * a graph, subgraph link or parked node is gone or changed kind. The run is unchanged.
   */
  'workflow_code_incompatible',
  /** The folder named for a checkpoint export cannot hold one. See `destinationIssue`. */
  'workflow_checkpoint_destination_rejected',
);

/** Reasons that carry no mandatory context of their own. */
const workflowPlainRejectionReasonSchema = Schema.Literal(
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
  'workflow_inputs_rejected',
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
  /** The workflow's `environment` hook threw, or returned a value the placement schema refuses. */
  'workflow_environment_selection_failed',
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
);

/**
 * Every expected workflow failure a client is meant to handle. Derived from the two sets the data
 * variants use, so a reason can never be advertised here while `workflowRejectedErrorSchema`
 * rejects it.
 */
export const workflowRejectionReasonSchema = Schema.Union(
  workflowPlainRejectionReasonSchema,
  workflowContextualRejectionReasonSchema,
);

/**
 * The rejection payload, discriminated by reason so the reasons with mandatory context cannot be
 * sent without it.
 */
export const workflowRejectionDataSchema = Schema.Union(
  Schema.Struct({
    ...workflowRejectionContextFields,
    reason: Schema.Literal('workflow_structure_validation_failed', 'workflow_code_incompatible'),
    /** Which registrations are wrong. Addressable records, never one free-text sentence. */
    diagnostics: Schema.Array(workflowStructureDiagnosticSchema),
  }),
  Schema.Struct({
    ...workflowRejectionContextFields,
    reason: Schema.Literal('workflow_checkpoint_destination_rejected'),
    /** The path as the runtime judged it: canonical when it got that far, otherwise as given. */
    destinationPath: Schema.String.pipe(Schema.minLength(1)),
    destinationIssue: worktreeDestinationIssueSchema,
  }),
  Schema.Struct({
    ...workflowRejectionContextFields,
    reason: workflowPlainRejectionReasonSchema,
  }),
);

export const workflowRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('workflow_rejected'),
  status: Schema.Union(Schema.Literal(400), Schema.Literal(409), Schema.Literal(500)),
  message: Schema.String,
  requestId: Schema.String,
  data: workflowRejectionDataSchema,
});

export const projectRelocationRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('project_relocation_rejected'),
  status: Schema.Union(Schema.Literal(400), Schema.Literal(409)),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: projectRelocationRejectionReasonSchema,
    projectId: Schema.Number.pipe(Schema.int(), Schema.positive()),
    path: Schema.optional(Schema.String),
    conflictingProjectId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  }),
});

export const gitCommandFailedErrorSchema = Schema.Struct({
  code: Schema.Literal('git_command_failed'),
  status: Schema.Literal(500),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    args: Schema.Array(Schema.String),
    cwd: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

export const runtimeDatabaseFailedErrorSchema = Schema.Struct({
  code: Schema.Literal('runtime_database_failed'),
  status: Schema.Literal(500),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    operation: Schema.String,
  }),
});

export const runtimeStateFileFailedErrorSchema = Schema.Struct({
  code: Schema.Literal('runtime_state_file_failed'),
  status: Schema.Literal(500),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    operation: Schema.String,
  }),
});

export const runtimeDataDirectoryFailedErrorSchema = Schema.Struct({
  code: Schema.Literal('runtime_data_directory_failed'),
  status: Schema.Literal(500),
  message: Schema.String,
  requestId: Schema.String,
});

export const workspaceGetApiErrorSchema = Schema.Union(
  gitCommandFailedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeStateFileFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
);

export const workspaceActiveContextApiErrorSchema = Schema.Union(
  workspaceActiveContextRejectedErrorSchema,
  gitCommandFailedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeStateFileFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
);

export const workspaceReconcileApiErrorSchema = Schema.Union(
  workspaceReconcileRejectedErrorSchema,
  gitCommandFailedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
);

export const surfaceApiErrorSchema = Schema.Union(
  surfaceRejectedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
);

/**
 * Request-boundary refusals: the operation was not attempted. Presented by the
 * caller that made the request, never folded into the editor's own projection.
 */
export const editorRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('editor_rejected'),
  status: Schema.Literal(400),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: editorRejectionReasonSchema,
    worktreeId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
    editorContextId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
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
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: editorAttemptFailureReasonSchema,
    editorContextId: Schema.Number.pipe(Schema.int(), Schema.positive()),
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
  message: Schema.String,
  requestId: Schema.String,
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
export const editorApiErrorSchema = Schema.Union(
  apiInfrastructureErrorSchema,
  editorRejectedErrorSchema,
  editorLaunchFailedErrorSchema,
  editorDiagnosticsUnavailableErrorSchema,
  surfaceRejectedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
);

export const worktreeEnvironmentFocusApiErrorSchema = Schema.Union(
  worktreeEnvironmentFocusRejectedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
);

export const sessionLaunchApiErrorSchema = Schema.Union(
  sessionLaunchRejectedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
);

export const worktreeCommandsApiErrorSchema = Schema.Union(
  worktreeCommandsRejectedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
);

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
const workflowApiErrorUnion = Schema.Union(
  workflowRejectedErrorSchema,
  projectPathRejectedErrorSchema,
  worktreeSetupRejectedErrorSchema,
  gitCommandFailedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeStateFileFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
);

/**
 * Named rather than inferred. Every workflow endpoint carries this schema, and declaration emit
 * would otherwise spell out the whole union at each one, which exceeds what the compiler will
 * serialize for `workflowsEndpoints`.
 */
export interface WorkflowApiErrorSchema extends Schema.Schema<
  typeof workflowApiErrorUnion.Type,
  typeof workflowApiErrorUnion.Encoded
> {}

export const workflowApiErrorSchema: WorkflowApiErrorSchema = workflowApiErrorUnion;

export const projectApiErrorSchema = Schema.Union(
  projectOperationRejectedErrorSchema,
  projectPathRejectedErrorSchema,
  gitCommandFailedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeStateFileFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
);

export const projectRelocateApiErrorSchema = Schema.Union(
  projectRelocationRejectedErrorSchema,
  projectPathRejectedErrorSchema,
  gitCommandFailedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
);

export const projectDeleteApiErrorSchema = Schema.Union(
  projectDeleteRejectedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
);

export const projectOrderApiErrorSchema = Schema.Union(
  projectOrderRejectedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
);

export const worktreeOrderApiErrorSchema = Schema.Union(
  worktreeOrderRejectedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
);

export const surfaceOrderApiErrorSchema = Schema.Union(
  surfaceOrderRejectedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
);

export const worktreeBranchListApiErrorSchema = Schema.Union(
  worktreeBranchListRejectedErrorSchema,
  gitCommandFailedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
);

export const worktreeOpenApiErrorSchema = Schema.Union(
  worktreeOpenRejectedErrorSchema,
  gitCommandFailedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
);

export const worktreeSetupApiErrorSchema = Schema.Union(
  worktreeSetupRejectedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
);

export const worktreeDeleteApiErrorSchema = Schema.Union(
  worktreeDeleteRejectedErrorSchema,
  gitCommandFailedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
);

export type ProjectPathRejectionReason = Schema.Schema.Type<
  typeof projectPathRejectionReasonSchema
>;
export type WorkspaceActiveContextRejectionReason = Schema.Schema.Type<
  typeof workspaceActiveContextRejectionReasonSchema
>;
export type WorkspaceReconcileRejectionReason = Schema.Schema.Type<
  typeof workspaceReconcileRejectionReasonSchema
>;
export type SurfaceRejectionReason = Schema.Schema.Type<typeof surfaceRejectionReasonSchema>;
export type EditorRejectionReason = Schema.Schema.Type<typeof editorRejectionReasonSchema>;
export type WorktreeEnvironmentFocusRejectionReason = Schema.Schema.Type<
  typeof worktreeEnvironmentFocusRejectionReasonSchema
>;
export type SessionLaunchRejectionReason = Schema.Schema.Type<
  typeof sessionLaunchRejectionReasonSchema
>;
export type WorktreeCommandsRejectionReason = Schema.Schema.Type<
  typeof worktreeCommandsRejectionReasonSchema
>;
export type WorkflowRejectionReason = Schema.Schema.Type<typeof workflowRejectionReasonSchema>;
export type WorkflowRejectionData = Schema.Schema.Type<typeof workflowRejectionDataSchema>;
export type ProjectRelocationRejectionReason = Schema.Schema.Type<
  typeof projectRelocationRejectionReasonSchema
>;
export type ProjectOperationRejectionReason = Schema.Schema.Type<
  typeof projectOperationRejectionReasonSchema
>;
export type ProjectDeleteRejectionReason = Schema.Schema.Type<
  typeof projectDeleteRejectionReasonSchema
>;
export type WorktreeOperationRejectionReason = Schema.Schema.Type<
  typeof worktreeOperationRejectionReasonSchema
>;
export type WorktreeSetupRejectionReason = Schema.Schema.Type<
  typeof worktreeSetupRejectionReasonSchema
>;
export type WorktreeDeleteRejectionReason = Schema.Schema.Type<
  typeof worktreeDeleteRejectionReasonSchema
>;
export type ProjectOrderRejectionReason = Schema.Schema.Type<
  typeof projectOrderRejectionReasonSchema
>;
export type WorktreeOrderRejectionReason = Schema.Schema.Type<
  typeof worktreeOrderRejectionReasonSchema
>;
export type SurfaceOrderRejectionReason = Schema.Schema.Type<
  typeof surfaceOrderRejectionReasonSchema
>;
export type ProjectOrderRejectedError = Schema.Schema.Type<typeof projectOrderRejectedErrorSchema>;
export type WorktreeOrderRejectedError = Schema.Schema.Type<
  typeof worktreeOrderRejectedErrorSchema
>;
export type SurfaceOrderRejectedError = Schema.Schema.Type<typeof surfaceOrderRejectedErrorSchema>;
export type ProjectPathRejectedError = Schema.Schema.Type<typeof projectPathRejectedErrorSchema>;
export type WorkspaceActiveContextRejectedError = Schema.Schema.Type<
  typeof workspaceActiveContextRejectedErrorSchema
>;
export type WorkspaceReconcileRejectedError = Schema.Schema.Type<
  typeof workspaceReconcileRejectedErrorSchema
>;
export type SurfaceRejectedError = Schema.Schema.Type<typeof surfaceRejectedErrorSchema>;
export type EditorRejectedError = Schema.Schema.Type<typeof editorRejectedErrorSchema>;
export type EditorLaunchFailedError = Schema.Schema.Type<typeof editorLaunchFailedErrorSchema>;
export type EditorDiagnosticsUnavailableError = Schema.Schema.Type<
  typeof editorDiagnosticsUnavailableErrorSchema
>;
export type WorktreeEnvironmentFocusRejectedError = Schema.Schema.Type<
  typeof worktreeEnvironmentFocusRejectedErrorSchema
>;
export type SessionLaunchRejectedError = Schema.Schema.Type<
  typeof sessionLaunchRejectedErrorSchema
>;
export type WorktreeCommandsRejectedError = Schema.Schema.Type<
  typeof worktreeCommandsRejectedErrorSchema
>;
export type ProjectRelocationRejectedError = Schema.Schema.Type<
  typeof projectRelocationRejectedErrorSchema
>;
export type ProjectOperationRejectedError = Schema.Schema.Type<
  typeof projectOperationRejectedErrorSchema
>;
export type ProjectDeleteRejectedError = Schema.Schema.Type<
  typeof projectDeleteRejectedErrorSchema
>;
export type WorktreeBranchListRejectedError = Schema.Schema.Type<
  typeof worktreeBranchListRejectedErrorSchema
>;
export type WorktreeOpenRejectedError = Schema.Schema.Type<typeof worktreeOpenRejectedErrorSchema>;
export type WorktreeSetupRejectedError = Schema.Schema.Type<
  typeof worktreeSetupRejectedErrorSchema
>;
export type WorktreeDeleteRejectedError = Schema.Schema.Type<
  typeof worktreeDeleteRejectedErrorSchema
>;
