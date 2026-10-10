import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReconciliationFinding } from '@isagi/contracts';

import { runApp } from '../../state/runtime.js';
import { toastsAtom } from '../../toast/index.js';
import { commitRelocateProjectSuccess } from '../commits.js';
import { holdWorkspace, project, workspaceSession } from './test-support.js';

test('reconciliation warning names the missing project path', async (t) => {
  const { registry, reads } = workspaceSession(t, [
    { projects: [project({ id: 1, name: 'existing' })] },
  ]);
  await holdWorkspace(t, registry);
  const findings = [
    {
      kind: 'project_missing',
      projectId: 1,
      path: '/repo/missing-project',
    },
  ] satisfies ReconciliationFinding[];

  await runApp(registry, commitRelocateProjectSuccess(findings));

  const toast = registry
    .get(toastsAtom)
    .find((candidate) => candidate.id === 'workspace-project-missing');
  assert.equal(toast?.title, 'Project unavailable.');
  assert.equal(toast?.subtitle, '/repo/missing-project — open the row to fix or remove it.');
  assert.equal(reads(), 2, 'the held workspace was re-read');
});

test('reconciliation warning names the missing worktree branch and path', async (t) => {
  const { registry, reads } = workspaceSession(t, [
    { projects: [project({ id: 1, name: 'existing' })] },
  ]);
  await holdWorkspace(t, registry);
  const findings = [
    {
      kind: 'worktree_missing',
      projectId: 1,
      worktreeId: 10,
      branch: 'feature/lost-context',
      path: '/repo/existing/.worktrees/lost-context',
    },
  ] satisfies ReconciliationFinding[];

  await runApp(registry, commitRelocateProjectSuccess(findings));

  const toast = registry
    .get(toastsAtom)
    .find((candidate) => candidate.id === 'workspace-worktree-missing');
  assert.equal(toast?.title, 'Worktree missing: feature/lost-context.');
  assert.equal(
    toast?.subtitle,
    'feature/lost-context at /repo/existing/.worktrees/lost-context — gone from Git.',
  );
  assert.equal(reads(), 2, 'the held workspace was re-read');
});
