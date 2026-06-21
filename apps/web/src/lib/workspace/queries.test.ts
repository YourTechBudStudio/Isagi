import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient } from '@tanstack/react-query';
import { Effect } from 'effect';

import type { ReconciliationFinding, SetSplitWeightsOutput } from '@isagi/contracts';

import { queryClient } from '../query/client.js';
import { clearToasts, useToastStore } from '../toast/index.js';
import { activateSurface } from './activation.js';
import type { WorkspaceData } from './model.js';
import {
  commitAddProjectSuccess,
  commitDeleteWorktreeSuccess,
  commitDeleteSurfaceSuccess,
  commitLaunchSessionSuccess,
  commitOpenWorktreeSuccess,
  commitRelocateProjectSuccess,
  setSplitWeightsFromSurface,
  startAgentSessionFromPalette,
} from './queries.js';
import { surfaceDetailQueryKey, workspaceQueryKey } from './query-keys.js';
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

test('split resize commit writes the returned layout into the surface cache', async () => {
  const client = new QueryClient();
  client.setQueryData(surfaceDetailQueryKey(700), {
    id: 700,
    layout: splitWeightsOutput(700, [0.5, 0.5]).layout,
  });

  await setSplitWeightsFromSurface({
    surfaceId: 700,
    weights: { nodeId: 'split-1', weights: [0.3, 0.7] },
    client,
    commit: (surfaceId, weights) => Promise.resolve(splitWeightsOutput(surfaceId, weights.weights)),
  });

  assert.deepEqual(cachedSurfaceWeights(client, 700), [0.3, 0.7]);
});

test('split resize commit invalidates the surface detail when the commit fails', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });
  client.setQueryData(surfaceDetailQueryKey(701), {
    id: 701,
    layout: splitWeightsOutput(701, [0.5, 0.5]).layout,
  });
  const commitError = new Error('resize commit failed');

  await assert.rejects(
    () =>
      setSplitWeightsFromSurface({
        surfaceId: 701,
        weights: { nodeId: 'split-1', weights: [0.3, 0.7] },
        client,
        commit: () => Promise.reject(commitError),
      }),
    { message: commitError.message },
  );

  // The corrective refetch is armed and the cache layout is left untouched for it.
  assert.equal(client.getQueryState(surfaceDetailQueryKey(701))?.isInvalidated, true);
  assert.deepEqual(cachedSurfaceWeights(client, 701), [0.5, 0.5]);
});

test('split resize keeps the newest layout when an older commit response lands last', async () => {
  const client = new QueryClient();
  client.setQueryData(surfaceDetailQueryKey(702), {
    id: 702,
    layout: splitWeightsOutput(702, [0.5, 0.5]).layout,
  });

  const pending: Array<(output: SetSplitWeightsOutput) => void> = [];
  const defer = () =>
    new Promise<SetSplitWeightsOutput>((resolve) => {
      pending.push(resolve);
    });

  const older = setSplitWeightsFromSurface({
    surfaceId: 702,
    weights: { nodeId: 'split-1', weights: [0.3, 0.7] },
    client,
    commit: defer,
  });
  const newer = setSplitWeightsFromSurface({
    surfaceId: 702,
    weights: { nodeId: 'split-1', weights: [0.8, 0.2] },
    client,
    commit: defer,
  });

  // The newer commit resolves first; the older (now stale) one lands last and must
  // not overwrite the newer intent.
  pending[1]!(splitWeightsOutput(702, [0.8, 0.2]));
  await newer;
  pending[0]!(splitWeightsOutput(702, [0.3, 0.7]));
  await older;

  assert.deepEqual(cachedSurfaceWeights(client, 702), [0.8, 0.2]);
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

test('surface focus persistence ignores stale success responses', async () => {
  const originalFetch = globalThis.fetch;
  const hadWindow = 'window' in globalThis;
  const originalWindow = globalThis.window;
  const requests: SurfaceFocusRequest[] = [];

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      isagi: {
        getRuntimeUrl: () => Promise.resolve('http://runtime.test'),
      },
    },
  });

  globalThis.fetch = ((_input, init) =>
    new Promise<Response>((resolve) => {
      const body = JSON.parse(String(init?.body)) as {
        readonly activeSurfaceId: number;
        readonly activePaneId: number | null;
      };
      requests.push({
        surfaceId: body.activeSurfaceId,
        paneId: body.activePaneId,
        resolve: () =>
          resolve(
            new Response(
              JSON.stringify({
                data: {
                  worktreeId: 10,
                  activeSurfaceId: body.activeSurfaceId,
                  activePaneId: body.activePaneId,
                },
                meta: { requestId: `focus-${body.activeSurfaceId}` },
              }),
              { status: 200 },
            ),
          ),
      });
    })) as typeof fetch;

  try {
    queryClient.clear();
    queryClient.setQueryData<WorkspaceData>(workspaceQueryKey, {
      projects: [
        project({
          id: 1,
          name: 'existing',
          surfaces: [
            { id: 101, title: 'Pi', paneKinds: ['agent_session'], attention: 'idle' },
            { id: 102, title: 'Terminal', paneKinds: ['terminal_session'], attention: 'idle' },
          ],
        }),
      ],
    });
    queryClient.setQueryData(surfaceDetailQueryKey(101), surfaceDetail(101, 201));
    queryClient.setQueryData(surfaceDetailQueryKey(102), surfaceDetail(102, 202));
    useWorkspaceStore.setState({ activeSurfaceByWorktreeId: {} });

    activateSurface({ worktreeId: 10, surfaceId: 101 });
    activateSurface({ worktreeId: 10, surfaceId: 102 });
    await waitFor(() => requests.length === 2);

    requests[1]!.resolve();
    await waitFor(() => activeSurfaceIdFromCache() === 102);

    requests[0]!.resolve();
    await Promise.resolve();
    assert.equal(activeSurfaceIdFromCache(), 102);
    assert.equal(
      queryClient.getQueryData<SurfaceDetailLike>(surfaceDetailQueryKey(102))?.activePaneId,
      202,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (hadWindow) {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
    queryClient.clear();
    useWorkspaceStore.setState({ activeSurfaceByWorktreeId: {}, activePaneBySurfaceId: {} });
  }
});

test('surface delete prevents stale focus persistence from restoring deleted surface', async () => {
  const originalFetch = globalThis.fetch;
  const hadWindow = 'window' in globalThis;
  const originalWindow = globalThis.window;
  const requests: SurfaceFocusRequest[] = [];

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      isagi: {
        getRuntimeUrl: () => Promise.resolve('http://runtime.test'),
      },
    },
  });

  globalThis.fetch = ((_input, init) =>
    new Promise<Response>((resolve) => {
      const body = JSON.parse(String(init?.body)) as {
        readonly activeSurfaceId: number;
        readonly activePaneId: number | null;
      };
      requests.push({
        surfaceId: body.activeSurfaceId,
        paneId: body.activePaneId,
        resolve: () =>
          resolve(
            new Response(
              JSON.stringify({
                data: {
                  worktreeId: 10,
                  activeSurfaceId: body.activeSurfaceId,
                  activePaneId: body.activePaneId,
                },
                meta: { requestId: `focus-${body.activeSurfaceId}` },
              }),
              { status: 200 },
            ),
          ),
      });
    })) as typeof fetch;

  try {
    queryClient.clear();
    queryClient.setQueryData<WorkspaceData>(workspaceQueryKey, {
      projects: [
        project({
          id: 1,
          name: 'existing',
          surfaces: [
            { id: 101, title: 'Pi', paneKinds: ['agent_session'], attention: 'idle' },
            { id: 102, title: 'Terminal', paneKinds: ['terminal_session'], attention: 'idle' },
          ],
        }),
      ],
    });
    queryClient.setQueryData(surfaceDetailQueryKey(101), surfaceDetail(101, 201));
    useWorkspaceStore.setState({ activeSurfaceByWorktreeId: { 10: 101 } });

    activateSurface({ worktreeId: 10, surfaceId: 101 });
    await waitFor(() => requests.length === 1);

    await commitDeleteSurfaceSuccess(queryClient, {
      worktreeId: 10,
      surfaceId: 101,
      output: {
        deletedSurfaceId: 101,
        deletedPaneIds: [201],
      },
      fetchWorkspaceData: async () => ({
        projects: [
          project({
            id: 1,
            name: 'fresh',
            surfaces: [
              { id: 102, title: 'Terminal', paneKinds: ['terminal_session'], attention: 'idle' },
            ],
          }),
        ],
      }),
    });

    assert.notEqual(activeSurfaceIdFromCache(), 101);
    requests[0]!.resolve();
    await Promise.resolve();
    assert.notEqual(activeSurfaceIdFromCache(), 101);
    assert.deepEqual(useWorkspaceStore.getState().activeSurfaceByWorktreeId, {});
  } finally {
    globalThis.fetch = originalFetch;
    if (hadWindow) {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
    queryClient.clear();
    useWorkspaceStore.setState({ activeSurfaceByWorktreeId: {}, activePaneBySurfaceId: {} });
  }
});

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

function activeSurfaceIdFromCache() {
  return queryClient.getQueryData<WorkspaceData>(workspaceQueryKey)?.projects[0]?.worktrees[0]
    ?.activeSurfaceId;
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for condition.');
}

interface SurfaceFocusRequest {
  readonly surfaceId: number;
  readonly paneId: number | null;
  readonly resolve: () => void;
}

interface SurfaceDetailLike {
  readonly id: number;
  readonly worktreeId: number;
  readonly title: string;
  readonly attention: 'idle';
  readonly layout: {
    readonly kind: 'leaf';
    readonly nodeId: string;
    readonly paneId: number;
    readonly collapsed: false;
  };
  readonly activePaneId: number | null;
  readonly panes: readonly [
    {
      readonly id: number;
      readonly surfaceId: number;
      readonly title: string;
      readonly attention: 'idle';
      readonly sortOrder: 0;
      readonly session: null;
    },
  ];
}

function surfaceDetail(surfaceId: number, paneId: number): SurfaceDetailLike {
  return {
    id: surfaceId,
    worktreeId: 10,
    title: 'Terminal',
    attention: 'idle',
    layout: { kind: 'leaf', nodeId: `pane-${paneId}`, paneId, collapsed: false },
    activePaneId: paneId,
    panes: [
      {
        id: paneId,
        surfaceId,
        title: 'Pane',
        attention: 'idle',
        sortOrder: 0,
        session: null,
      },
    ],
  };
}

function splitWeightsOutput(surfaceId: number, weights: readonly number[]): SetSplitWeightsOutput {
  return {
    surfaceId,
    layout: {
      kind: 'split',
      nodeId: 'split-1',
      axis: 'row',
      sizing: 'manual',
      children: [
        { kind: 'leaf', nodeId: 'pane-1', paneId: 1, collapsed: false },
        { kind: 'leaf', nodeId: 'pane-2', paneId: 2, collapsed: false },
      ],
      weights,
    },
  };
}

function cachedSurfaceWeights(client: QueryClient, surfaceId: number) {
  return (
    client.getQueryData(surfaceDetailQueryKey(surfaceId)) as
      | { readonly layout: { readonly weights: readonly number[] } }
      | undefined
  )?.layout.weights;
}

function project(input: {
  readonly id: number;
  readonly name: string;
  readonly surfaces?: WorkspaceData['projects'][number]['worktrees'][number]['surfaces'];
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
        surfaces: input.surfaces ?? [],
        activeSurfaceId: null,
      },
    ],
  };
}
