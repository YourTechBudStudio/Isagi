import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { worktrees } from '../projects/tables.js';
import { ptyProcesses } from '../pty-processes/tables.js';

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
  sessionKind: text('session_kind', {
    enum: ['agent_session', 'terminal_session', 'editor_context'],
  }),
  sessionId: integer('session_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
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
