import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
