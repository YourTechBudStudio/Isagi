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
