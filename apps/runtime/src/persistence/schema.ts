import { workflowWaitKinds } from '@yourtechbudstudio/isagi-workflow-sdk';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable(
  'projects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    rootPath: text('root_path').notNull(),
    status: text('status', { enum: ['present', 'missing'] }).notNull(),
    // Durable display rank among present sibling projects. Meaningless while a
    // project is missing: restoration always appends. See the rail reordering
    // plan; the value never leaves the repository.
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastSeenAt: text('last_seen_at'),
    missingReason: text('missing_reason'),
  },
  (table) => [uniqueIndex('projects_root_path_unique').on(table.rootPath)],
);

export const worktrees = sqliteTable(
  'worktrees',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    branch: text('branch'),
    head: text('head'),
    // Durable display rank among the project's worktrees. The root worktree is
    // derived (path === project.rootPath) and pinned first at snapshot
    // composition, so its stored rank carries no meaning.
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at'),
  },
  (table) => [uniqueIndex('worktrees_project_path_unique').on(table.projectId, table.path)],
);

export const worktreeSetupTrust = sqliteTable(
  'worktree_setup_trust',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['post_create'] }).notNull(),
    trustedHash: text('trusted_hash'),
    alwaysTrustProject: integer('always_trust_project', { mode: 'boolean' }).notNull(),
    hooksDisabled: integer('hooks_disabled', { mode: 'boolean' }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('worktree_setup_trust_project_scope_unique').on(table.projectId, table.scope),
  ],
);

export const worktreeSetupRuns = sqliteTable('worktree_setup_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  worktreeId: integer('worktree_id')
    .notNull()
    .references(() => worktrees.id, { onDelete: 'cascade' }),
  lifecycle: text('lifecycle', { enum: ['post_create'] }).notNull(),
  hookConfigHash: text('hook_config_hash').notNull(),
  status: text('status', { enum: ['succeeded', 'failed'] }).notNull(),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at').notNull(),
});

export const worktreeSetupSteps = sqliteTable('worktree_setup_steps', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id')
    .notNull()
    .references(() => worktreeSetupRuns.id, { onDelete: 'cascade' }),
  hookIndex: integer('hook_index').notNull(),
  hookType: text('hook_type', { enum: ['copy', 'symlink', 'command'] }).notNull(),
  status: text('status', { enum: ['succeeded', 'failed', 'skipped'] }).notNull(),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at').notNull(),
  message: text('message'),
  command: text('command'),
  src: text('src'),
  dest: text('dest'),
  exitCode: integer('exit_code'),
  signal: text('signal'),
  outputExcerpt: text('output_excerpt'),
});

export const worktreeSurfaces = sqliteTable('worktree_surfaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  worktreeId: integer('worktree_id')
    .notNull()
    .references(() => worktrees.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  layoutJson: text('layout_json').notNull(),
  sortOrder: integer('sort_order').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const surfacePanes = sqliteTable('surface_panes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  surfaceId: integer('surface_id')
    .notNull()
    .references(() => worktreeSurfaces.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  sortOrder: integer('sort_order').notNull(),
  sessionKind: text('session_kind', { enum: ['agent_session', 'terminal_session'] }),
  sessionId: integer('session_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const ptyProcesses = sqliteTable('pty_processes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  backend: text('backend', { enum: ['tmux', 'node_pty'] }).notNull(),
  backendRefJson: text('backend_ref_json').notNull(),
  command: text('command').notNull(),
  argsJson: text('args_json').notNull(),
  cwd: text('cwd').notNull(),
  status: text('status', {
    enum: ['starting', 'running', 'exited', 'failed', 'killed'],
  }).notNull(),
  statusReason: text('status_reason', {
    enum: [
      'user_requested',
      'runtime_shutdown',
      'backend_unavailable',
      'backend_process_missing',
      'backend_attach_failed',
      'backend_launch_failed',
      'runtime_ephemeral_lost',
    ],
  }),
  exitCode: integer('exit_code'),
  signal: text('signal'),
  logMode: text('log_mode', { enum: ['backend_file', 'none'] }).notNull(),
  logPath: text('log_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  exitedAt: text('exited_at'),
  lastSeenAt: text('last_seen_at'),
});

export const agentSessions = sqliteTable('agent_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  worktreeId: integer('worktree_id')
    .notNull()
    .references(() => worktrees.id, { onDelete: 'cascade' }),
  harness: text('harness', { enum: ['pi', 'opencode', 'claude', 'codex'] }).notNull(),
  cwd: text('cwd').notNull(),
  activePtyProcessId: integer('active_pty_process_id').references(() => ptyProcesses.id),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastSeenAt: text('last_seen_at'),
});

export const terminalSessions = sqliteTable('terminal_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  worktreeId: integer('worktree_id')
    .notNull()
    .references(() => worktrees.id, { onDelete: 'cascade' }),
  cwd: text('cwd').notNull(),
  shellCommand: text('shell_command').notNull(),
  shellArgsJson: text('shell_args_json').notNull(),
  activePtyProcessId: integer('active_pty_process_id').references(() => ptyProcesses.id),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const worktreeCommandStates = sqliteTable(
  'worktree_command_states',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    worktreeId: integer('worktree_id')
      .notNull()
      .references(() => worktrees.id, { onDelete: 'cascade' }),
    commandName: text('command_name').notNull(),
    status: text('status', {
      enum: ['idle', 'running', 'exited', 'stopped', 'failed', 'suspended'],
    }).notNull(),
    activePtyProcessId: integer('active_pty_process_id').references(() => ptyProcesses.id),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('worktree_command_states_worktree_command_unique').on(
      table.worktreeId,
      table.commandName,
    ),
    index('worktree_command_states_active_pty_idx').on(table.activePtyProcessId),
  ],
);

export const worktreeCommandRuns = sqliteTable(
  'worktree_command_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    worktreeId: integer('worktree_id')
      .notNull()
      .references(() => worktrees.id, { onDelete: 'cascade' }),
    commandName: text('command_name').notNull(),
    ptyProcessId: integer('pty_process_id').references(() => ptyProcesses.id),
    status: text('status', { enum: ['running', 'exited', 'stopped', 'failed'] }).notNull(),
    diagnosticReason: text('diagnostic_reason', {
      enum: [
        'missing_cwd',
        'env_invalid',
        'pty_launch_failed',
        'runtime_stopped',
        'process_control_failed',
      ],
    }),
    diagnosticDetail: text('diagnostic_detail'),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('worktree_command_runs_latest_idx').on(table.worktreeId, table.commandName, table.id),
    index('worktree_command_runs_pty_idx').on(table.ptyProcessId),
  ],
);

export const workflowRuns = sqliteTable(
  'workflow_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workflowKey: text('workflow_key').notNull(),
    workflowTitle: text('workflow_title').notNull(),
    workflowArtifactHash: text('workflow_artifact_hash'),
    worktreeId: integer('worktree_id').references(() => worktrees.id, { onDelete: 'cascade' }),
    surfaceId: integer('surface_id').references(() => worktreeSurfaces.id, {
      onDelete: 'set null',
    }),
    parentRunId: integer('parent_run_id').references((): AnySQLiteColumn => workflowRuns.id, {
      onDelete: 'cascade',
    }),
    rootRunId: integer('root_run_id').references((): AnySQLiteColumn => workflowRuns.id, {
      onDelete: 'cascade',
    }),
    status: text('status', {
      enum: ['waiting', 'ready', 'running', 'done', 'failed'],
    }).notNull(),
    controlRevision: integer('control_revision').notNull().default(0),
    retrying: integer('retrying', { mode: 'boolean' }).notNull().default(false),
    paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
    cancelRequested: integer('cancel_requested', { mode: 'boolean' }).notNull().default(false),
    waitKind: text('wait_kind', { enum: workflowWaitKinds }),
    waitCondition: text('wait_condition'),
    resumePayload: text('resume_payload'),
    stateJson: text('state_json').notNull(),
    stateVersion: integer('state_version').notNull(),
    owner: text('owner'),
    error: text('error'),
    resultJson: text('result_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('workflow_runs_status_idx').on(table.status),
    index('workflow_runs_status_wait_kind_idx').on(table.status, table.waitKind),
    index('workflow_runs_paused_idx').on(table.paused),
    index('workflow_runs_worktree_idx').on(table.worktreeId),
    index('workflow_runs_surface_idx').on(table.surfaceId),
    index('workflow_runs_root_idx').on(table.rootRunId),
  ],
);

export const workflowRunEvents = sqliteTable(
  'workflow_run_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workflowRunId: integer('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    recordedAt: text('recorded_at').notNull(),
    state: text('state').notNull(),
    trigger: text('trigger').notNull(),
  },
  (table) => [index('workflow_run_events_run_idx').on(table.workflowRunId, table.id)],
);

export const worktreeEnvironmentStates = sqliteTable(
  'worktree_environment_states',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    worktreeId: integer('worktree_id')
      .notNull()
      .references(() => worktrees.id, { onDelete: 'cascade' }),
    activeSurfaceId: integer('active_surface_id').references(() => worktreeSurfaces.id, {
      onDelete: 'set null',
    }),
    activePaneId: integer('active_pane_id').references(() => surfacePanes.id, {
      onDelete: 'set null',
    }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('worktree_environment_states_worktree_id_unique').on(table.worktreeId)],
);
