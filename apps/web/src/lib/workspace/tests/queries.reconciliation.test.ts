import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient } from '@tanstack/react-query';

import type { ReconciliationFinding } from '@isagi/contracts';

import { clearToasts, useToastStore } from '../../toast/index.js';
import type { WorkspaceData } from '../model.js';
import { commitRelocateProjectSuccess } from '../queries.js';
import { workspaceQueryKey } from '../query-keys.js';
import { project } from './test-support.js';

test('reconciliation warning names the missing project path', async () => {
  clearToasts();
  const client = new QueryClient();
  client.setQueryData<WorkspaceData>(workspaceQueryKey, {
    projects: [project({ id: 1, name: 'existing' })],
  });
  const findings = [
    {
      kind: 'project_missing',
      projectId: 1,
      path: '/repo/missing-project',
    },
  ] satisfies ReconciliationFinding[];

  await commitRelocateProjectSuccess(client, findings);

  const toast = useToastStore
    .getState()
    .toasts.find((candidate) => candidate.id === 'workspace-project-missing');
  assert.equal(toast?.title, 'Project unavailable.');
  assert.equal(toast?.subtitle, '/repo/missing-project — open the row to fix or remove it.');
  assert.equal(client.getQueryState(workspaceQueryKey)?.isInvalidated, true);
  clearToasts();
});

test('reconciliation warning names the missing worktree branch and path', async () => {
  clearToasts();
  const client = new QueryClient();
  client.setQueryData<WorkspaceData>(workspaceQueryKey, {
    projects: [project({ id: 1, name: 'existing' })],
  });
  const findings = [
    {
      kind: 'worktree_missing',
      projectId: 1,
      worktreeId: 10,
      branch: 'feature/lost-context',
      path: '/repo/existing/.worktrees/lost-context',
    },
  ] satisfies ReconciliationFinding[];

  await commitRelocateProjectSuccess(client, findings);

  const toast = useToastStore
    .getState()
    .toasts.find((candidate) => candidate.id === 'workspace-worktree-missing');
  assert.equal(toast?.title, 'Worktree missing: feature/lost-context.');
  assert.equal(
    toast?.subtitle,
    'feature/lost-context at /repo/existing/.worktrees/lost-context — gone from Git.',
  );
  assert.equal(client.getQueryState(workspaceQueryKey)?.isInvalidated, true);
  clearToasts();
});
