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
    worktreeId: Schema.Number.pipe(Schema.int(), Schema.positive()),
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

export const projectApiErrorSchema = Schema.Union(
  projectPathRejectedErrorSchema,
  gitCommandFailedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeStateFileFailedErrorSchema,
  runtimeDataDirectoryFailedErrorSchema,
);

export type ProjectPathRejectionReason = Schema.Schema.Type<
  typeof projectPathRejectionReasonSchema
>;
export type WorkspaceActiveContextRejectionReason = Schema.Schema.Type<
  typeof workspaceActiveContextRejectionReasonSchema
>;
export type ProjectPathRejectedError = Schema.Schema.Type<typeof projectPathRejectedErrorSchema>;
export type WorkspaceActiveContextRejectedError = Schema.Schema.Type<
  typeof workspaceActiveContextRejectedErrorSchema
>;
