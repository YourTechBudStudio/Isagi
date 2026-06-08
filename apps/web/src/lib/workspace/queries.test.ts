import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient } from '@tanstack/react-query';

import type { WorkspaceData } from './model.js';
import {
  commitAddProjectSuccess,
  commitOpenWorktreeSuccess,
  workspaceQueryKey,
} from './queries.js';
import { emptyWorkspaceSelection, useWorkspaceStore } from './store.js';

test('open-worktree success refetches workspace before selecting returned worktree', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });
  client.setQueryData<WorkspaceData>(workspaceQueryKey, {
    projects: [project({ id: 1, name: 'stale-but-fresh' })],
  });
  const events: string[] = [];
  useWorkspaceStore.getState().setSelection(emptyWorkspaceSelection);

  await commitOpenWorktreeSuccess(
    client,
    {
      projectId: 2,
      worktreeId: 22,
      branch: 'feature/new',
      status: 'created',
      setup: { status: 'skipped', reason: 'not_configured' },
    },
    async () => {
      events.push(`fetch:${useWorkspaceStore.getState().selection.kind}`);
      return { projects: [project({ id: 2, name: 'next' })] };
    },
  );

  events.push(`select:${useWorkspaceStore.getState().selection.kind}`);
  assert.deepEqual(events, ['fetch:empty', 'select:worktree']);
  assert.deepEqual(useWorkspaceStore.getState().selection, {
    kind: 'worktree',
    projectId: 2,
    worktreeId: 22,
  });
  assert.equal(client.getQueryData<WorkspaceData>(workspaceQueryKey)?.projects[0]?.id, 2);
});

test('add-project success invalidates the workspace query without cache surgery', async () => {
  const client = new QueryClient();
  client.setQueryData<WorkspaceData>(workspaceQueryKey, {
    projects: [project({ id: 1, name: 'existing' })],
  });

  await commitAddProjectSuccess(client, { reconcile: false });

  const data = client.getQueryData<WorkspaceData>(workspaceQueryKey);
  assert.deepEqual(
    data?.projects.map((candidate) => candidate.id),
    [1],
  );
  assert.equal(client.getQueryState(workspaceQueryKey)?.isInvalidated, true);
});

function project(input: {
  readonly id: number;
  readonly name: string;
}): WorkspaceData['projects'][number] {
  return {
    id: input.id,
    name: input.name,
    rootPath: `/repo/${input.name}`,
    status: 'present',
    glyph: input.name.slice(0, 2).toUpperCase(),
    accent: 'blue',
    worktrees: [
      {
        id: input.id * 10,
        projectId: input.id,
        title: 'main',
        path: `/repo/${input.name}`,
        branch: 'main',
        head: 'abcdef0',
        isRoot: true,
        attention: 'idle',
        parked: false,
        surfaces: [],
        activeSurfaceId: null,
        commands: [],
      },
    ],
  };
}
