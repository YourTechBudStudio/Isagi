import { Schema } from 'effect';

export const projectPathRejectionReasonSchema = Schema.Literal(
  'path_not_found',
  'not_directory',
  'not_git_repository',
  'not_repository_root',
  'linked_worktree_checkout',
  'permission_denied',
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

export const workspaceReconcileRejectionReasonSchema = Schema.Literal('project_not_found');

export const surfaceRejectionReasonSchema = Schema.Literal(
  'surface_not_found',
  'pane_not_found',
  'worktree_not_found',
  'session_not_found',
  'session_worktree_mismatch',
  'invalid_surface_title',
);

export const worktreeEnvironmentFocusRejectionReasonSchema = Schema.Literal(
  'worktree_not_found',
  'surface_not_found',
  'pane_not_found',
);

export const sessionLaunchRejectionReasonSchema = Schema.Literal('worktree_not_found');

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
);

export const worktreeSetupRejectionReasonSchema = Schema.Literal(
  'project_not_found',
  'project_not_present',
  'setup_not_configured',
  'setup_config_invalid',
  'setup_trust_mismatch',
);

export const worktreeDeleteRejectionReasonSchema = Schema.Literal(
  'project_not_found',
  'project_not_present',
  'worktree_not_found',
  'root_worktree_not_deletable',
  'dirty_checkout_requires_force',
  'root_worktree_not_found',
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
  }),
});

export const worktreeCommandsRejectedErrorSchema = Schema.Struct({
  code: Schema.Literal('worktree_commands_rejected'),
  status: Schema.Literal(400),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.Struct({
    reason: worktreeCommandsRejectionReasonSchema,
    worktreeId: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
    commandName: Schema.optional(Schema.String),
  }),
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

export const projectApiErrorSchema = Schema.Union(
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
export type WorktreeEnvironmentFocusRejectionReason = Schema.Schema.Type<
  typeof worktreeEnvironmentFocusRejectionReasonSchema
>;
export type SessionLaunchRejectionReason = Schema.Schema.Type<
  typeof sessionLaunchRejectionReasonSchema
>;
export type WorktreeCommandsRejectionReason = Schema.Schema.Type<
  typeof worktreeCommandsRejectionReasonSchema
>;
export type ProjectRelocationRejectionReason = Schema.Schema.Type<
  typeof projectRelocationRejectionReasonSchema
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
export type ProjectPathRejectedError = Schema.Schema.Type<typeof projectPathRejectedErrorSchema>;
export type WorkspaceActiveContextRejectedError = Schema.Schema.Type<
  typeof workspaceActiveContextRejectedErrorSchema
>;
export type WorkspaceReconcileRejectedError = Schema.Schema.Type<
  typeof workspaceReconcileRejectedErrorSchema
>;
export type SurfaceRejectedError = Schema.Schema.Type<typeof surfaceRejectedErrorSchema>;
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
