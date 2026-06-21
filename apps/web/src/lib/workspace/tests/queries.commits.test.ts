import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient } from '@tanstack/react-query';
import { Effect } from 'effect';

import { clearToasts } from '../../toast/index.js';
import type { WorkspaceData } from '../model.js';
import {
  commitAddProjectSuccess,
  commitDeleteSurfaceSuccess,
  commitDeleteWorktreeSuccess,
  commitLaunchSessionSuccess,
  commitOpenWorktreeSuccess,
  startAgentSessionFromPalette,
} from '../queries.js';
import { surfaceDetailQueryKey, workspaceQueryKey } from '../query-keys.js';
import { emptyWorkspaceSelection, useWorkspaceStore } from '../store.js';
import { project } from './test-support.js';

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

test('launch success refetches workspace and selects the new surface locally', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });
  client.setQueryData<WorkspaceData>(workspaceQueryKey, {
    projects: [
      project({
        id: 1,
        name: 'stale',
        surfaces: [
          { id: 100, title: 'Terminal', paneKinds: ['terminal_session'], attention: 'idle' },
        ],
      }),
    ],
  });
  const events: string[] = [];
  useWorkspaceStore.setState({
    selection: emptyWorkspaceSelection,
    activeSurfaceByWorktreeId: {},
    activePaneBySurfaceId: {},
  });

  await commitLaunchSessionSuccess(
    client,
    {
      worktreeId: 10,
      surfaceId: 501,
      paneId: 601,
      title: 'Terminal 2',
    },
    async () => {
      events.push(`fetch:${useWorkspaceStore.getState().activeSurfaceByWorktreeId[10] ?? 'none'}`);
      return {
        projects: [
          project({
            id: 1,
            name: 'fresh',
            surfaces: [
              {
                id: 501,
                title: 'Terminal 2',
                paneKinds: ['terminal_session'],
                attention: 'working',
              },
            ],
          }),
        ],
      };
    },
  );

  events.push(`select:${useWorkspaceStore.getState().activeSurfaceByWorktreeId[10] ?? 'none'}`);
  assert.deepEqual(events, ['fetch:none', 'select:501']);
  assert.equal(useWorkspaceStore.getState().activePaneBySurfaceId[501], 601);
  assert.equal(client.getQueryData<WorkspaceData>(workspaceQueryKey)?.projects[0]?.name, 'fresh');
});

test('failed agent launch invalidates workspace so persisted empty surfaces can appear', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });
  client.setQueryData<WorkspaceData>(workspaceQueryKey, {
    projects: [
      project({
        id: 1,
        name: 'stale',
        surfaces: [],
      }),
    ],
  });
  const launchError = new Error('agent session creation failed');

  await assert.rejects(
    () => startAgentSessionFromPalette(10, 'pi', () => Effect.fail(launchError), client),
    { message: launchError.message },
  );

  assert.equal(client.getQueryState(workspaceQueryKey)?.isInvalidated, true);
});

test('delete surface success refetches workspace and clears only stale local overrides', async () => {
  clearToasts();
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });
  client.setQueryData<WorkspaceData>(workspaceQueryKey, {
    projects: [
      project({
        id: 1,
        name: 'stale',
        surfaces: [
          { id: 501, title: 'Terminal', paneKinds: ['terminal_session'], attention: 'idle' },
        ],
      }),
    ],
  });
  client.setQueryData(surfaceDetailQueryKey(501), { id: 501 });
  useWorkspaceStore.setState({
    activeSurfaceByWorktreeId: { 10: 501, 20: 999 },
    activePaneBySurfaceId: { 501: 601, 999: 1001 },
  });

  await commitDeleteSurfaceSuccess(client, {
    worktreeId: 10,
    surfaceId: 501,
    output: {
      deletedSurfaceId: 501,
      deletedPaneIds: [601],
    },
    fetchWorkspaceData: async () => ({
      projects: [
        project({
          id: 1,
          name: 'fresh',
          surfaces: [
            { id: 502, title: 'Terminal 2', paneKinds: ['terminal_session'], attention: 'idle' },
          ],
        }),
      ],
    }),
  });

  assert.equal(client.getQueryData(surfaceDetailQueryKey(501)), undefined);
  assert.deepEqual(useWorkspaceStore.getState().activeSurfaceByWorktreeId, { 20: 999 });
  assert.deepEqual(useWorkspaceStore.getState().activePaneBySurfaceId, { 999: 1001 });
  assert.equal(client.getQueryData<WorkspaceData>(workspaceQueryKey)?.projects[0]?.name, 'fresh');
});

test('delete pane success clears only the deleted pane override', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });
  client.setQueryData(surfaceDetailQueryKey(501), { id: 501 });
  useWorkspaceStore.setState({
    activeSurfaceByWorktreeId: { 10: 501 },
    activePaneBySurfaceId: { 501: 601 },
  });

  await commitDeleteSurfaceSuccess(client, {
    worktreeId: 10,
    surfaceId: 501,
    paneId: 601,
    output: {
      deletedSurfaceId: null,
      deletedPaneIds: [601],
    },
    fetchWorkspaceData: async () => ({
      projects: [
        project({
          id: 1,
          name: 'fresh',
          surfaces: [
            { id: 501, title: 'Terminal', paneKinds: ['terminal_session'], attention: 'idle' },
          ],
        }),
      ],
    }),
  });

  assert.deepEqual(useWorkspaceStore.getState().activeSurfaceByWorktreeId, { 10: 501 });
  assert.deepEqual(useWorkspaceStore.getState().activePaneBySurfaceId, {});
  assert.deepEqual(client.getQueryData(surfaceDetailQueryKey(501)), { id: 501 });
});

test('delete worktree success refetches workspace and selects returned root worktree', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });
  const events: string[] = [];
  useWorkspaceStore.getState().setSelection(emptyWorkspaceSelection);

  await commitDeleteWorktreeSuccess(
    client,
    {
      projectId: 1,
      deletedWorktreeId: 11,
      selectedWorktreeId: 10,
      branchRemoval: { status: 'not_requested' },
    },
    async () => {
      events.push(`fetch:${useWorkspaceStore.getState().selection.kind}`);
      return {
        projects: [
          project({
            id: 1,
            name: 'fresh',
            surfaces: [],
          }),
        ],
      };
    },
  );

  events.push(`select:${useWorkspaceStore.getState().selection.kind}`);
  assert.deepEqual(events, ['fetch:empty', 'select:worktree']);
  assert.deepEqual(useWorkspaceStore.getState().selection, {
    kind: 'worktree',
    projectId: 1,
    worktreeId: 10,
  });
});

test('delete worktree success falls back through selection reconciliation when returned root is absent', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });
  useWorkspaceStore.getState().setSelection({
    kind: 'worktree',
    projectId: 1,
    worktreeId: 11,
  });

  await commitDeleteWorktreeSuccess(
    client,
    {
      projectId: 1,
      deletedWorktreeId: 11,
      selectedWorktreeId: 999,
      branchRemoval: { status: 'not_requested' },
    },
    async () => ({
      projects: [
        project({
          id: 1,
          name: 'fresh',
          surfaces: [],
        }),
      ],
    }),
  );

  assert.deepEqual(useWorkspaceStore.getState().selection, {
    kind: 'worktree',
    projectId: 1,
    worktreeId: 10,
  });
});
