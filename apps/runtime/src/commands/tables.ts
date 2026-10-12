import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { worktrees } from '../projects/tables.js';
import { ptyProcesses } from '../pty-processes/tables.js';

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
    // The latest successfully established resolved-port snapshot, as JSON source
    // facts. Written only by the launch-in-progress marker, so a failed attempt
    // cannot destroy the memory of the last successful resolution. Null means no
    // launch has ever resolved ports for this command.
    resolvedPortsJson: text('resolved_ports_json'),
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
        'port_allocation_failed',
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
