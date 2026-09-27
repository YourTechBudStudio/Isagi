import assert from 'node:assert/strict';
import test from 'node:test';

import { makeWorkflowPersistenceFixture } from './test-support.js';

/**
 * The foreign-key graph is what decides whether deleting an environment can reach run history.
 *
 * Both worktree removal paths — a person deleting a worktree and reconciliation pruning one that
 * vanished from Git — go through the one `WorkspaceRepository.deleteWorktree`, and a project
 * deletion cascades to its worktrees. So pinning the graph here covers every one of them: if no
 * workflow row can be reached from `worktrees` or `projects` except the surface attachment, no such
 * deletion can erase or alter a run, its history or its recorded owner. Checked on the migrated
 * schema, because that — not the Drizzle model — is what the database enforces.
 */

interface ForeignKey {
  readonly table: string;
  readonly from: string;
  readonly to: string;
  readonly onDelete: string;
}

/** The only environment references a workflow table may hold, and how each one behaves. */
const ALLOWED_ENVIRONMENT_KEYS: readonly ForeignKey[] = [
  { table: 'workflow_run_attachments', from: 'worktree_id', to: 'worktrees', onDelete: 'CASCADE' },
  {
    table: 'workflow_run_attachments',
    from: 'surface_id',
    to: 'worktree_surfaces',
    onDelete: 'SET NULL',
  },
];

test('only the surface attachment is tied to the environment; no workflow row references a project', () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const tables = (
      fixture.client
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'workflow\\_%' ESCAPE '\\'`,
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    assert.ok(tables.includes('workflow_runs'), 'the workflow tables are present');

    const keys: ForeignKey[] = tables.flatMap((table) =>
      (
        fixture.client.pragma(`foreign_key_list(${table})`) as {
          from: string;
          table: string;
          on_delete: string;
        }[]
      ).map((key) => ({ table, from: key.from, to: key.table, onDelete: key.on_delete })),
    );

    const environment = keys.filter((key) => !key.to.startsWith('workflow_'));
    assert.deepEqual(
      [...environment].sort((left, right) => left.from.localeCompare(right.from)),
      [...ALLOWED_ENVIRONMENT_KEYS].sort((left, right) => left.from.localeCompare(right.from)),
      'a new reference from workflow history to an environment or project row would let its deletion reach the history',
    );

    // The recorded owner in particular: a foreign key here would let a project deletion null or
    // erase attribution through SQL rather than through the workflow domain (#50).
    assert.deepEqual(
      keys.filter((key) => key.table === 'workflow_runs' && key.from === 'project_id'),
      [],
    );
  } finally {
    fixture.close();
  }
});
