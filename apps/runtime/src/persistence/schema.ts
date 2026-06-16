import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable(
  'projects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    rootPath: text('root_path').notNull(),
    status: text('status', { enum: ['present', 'missing'] }).notNull(),
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
  stdoutExcerpt: text('stdout_excerpt'),
  stderrExcerpt: text('stderr_excerpt'),
});

export const worktreeSurfaces = sqliteTable('worktree_surfaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  worktreeId: integer('worktree_id')
    .notNull()
    .references(() => worktrees.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['agent', 'terminal'] }).notNull(),
  title: text('title').notNull(),
  attention: text('attention', { enum: ['idle', 'working', 'waiting', 'error'] }).notNull(),
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
  attention: text('attention', { enum: ['idle', 'working', 'waiting', 'error'] }).notNull(),
  sortOrder: integer('sort_order').notNull(),
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

export const agentSessions = sqliteTable(
  'agent_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    paneId: integer('pane_id')
      .notNull()
      .references(() => surfacePanes.id, { onDelete: 'cascade' }),
    worktreeId: integer('worktree_id')
      .notNull()
      .references(() => worktrees.id, { onDelete: 'cascade' }),
    harness: text('harness', { enum: ['pi', 'opencode', 'claude', 'codex'] }).notNull(),
    cwd: text('cwd').notNull(),
    harnessSessionId: text('harness_session_id'),
    harnessSessionRefJson: text('harness_session_ref_json'),
    activePtyProcessId: integer('active_pty_process_id').references(() => ptyProcesses.id),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastSeenAt: text('last_seen_at'),
  },
  (table) => [uniqueIndex('agent_sessions_pane_id_unique').on(table.paneId)],
);

export const terminalSessions = sqliteTable(
  'terminal_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    paneId: integer('pane_id')
      .notNull()
      .references(() => surfacePanes.id, { onDelete: 'cascade' }),
    worktreeId: integer('worktree_id')
      .notNull()
      .references(() => worktrees.id, { onDelete: 'cascade' }),
    cwd: text('cwd').notNull(),
    shellCommand: text('shell_command').notNull(),
    shellArgsJson: text('shell_args_json').notNull(),
    activePtyProcessId: integer('active_pty_process_id').references(() => ptyProcesses.id),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('terminal_sessions_pane_id_unique').on(table.paneId)],
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
