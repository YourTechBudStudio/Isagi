import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { worktrees } from '../projects/tables.js';
import { ptyProcesses } from '../pty-processes/tables.js';

export const editorContexts = sqliteTable(
  'editor_contexts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    worktreeId: integer('worktree_id')
      .notNull()
      .references(() => worktrees.id, { onDelete: 'cascade' }),
    // The pointer to the replaceable incarnation (ADR 0006/0008). Cleared only in
    // the same transition that records an affirmatively terminated predecessor.
    activePtyProcessId: integer('active_pty_process_id').references(() => ptyProcesses.id),
    // What the runtime *chose* for this incarnation, written in the same durable
    // transition as the pointer. All three are null exactly when the pointer is.
    endpointHost: text('endpoint_host'),
    endpointPort: integer('endpoint_port'),
    sessionSocketPath: text('session_socket_path'),
    // The launch-attempt record. `in_progress` never coexists with a pointer;
    // that invariant is what makes boot's reading of it sound.
    attemptState: text('attempt_state', { enum: ['none', 'in_progress', 'failed'] }).notNull(),
    attemptReason: text('attempt_reason', {
      enum: [
        'port_allocation_failed',
        'session_socket_unavailable',
        'launch_allocation_failed',
        'launch_interrupted',
        'previous_incarnation_not_stopped',
        'launch_target_missing',
      ],
    }),
    attemptDetail: text('attempt_detail'),
    attemptStartedAt: text('attempt_started_at'),
    // Deliberately no `cwd` column, unlike `agent_sessions` and
    // `terminal_sessions`: the worktree's absolute path is re-resolved from the
    // `worktrees` row at every launch, so a relocated worktree can never be
    // launched into a stale directory. No `provider` column either — Code Server
    // is the only provider and the install path already names it.
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    // One editor context per worktree. The per-worktree lock serializes
    // find-and-place; this makes a duplicate impossible even if it did not.
    uniqueIndex('editor_contexts_worktree_id_unique').on(table.worktreeId),
    index('editor_contexts_active_pty_idx').on(table.activePtyProcessId),
  ],
);
