import assert from 'node:assert/strict';
import test from 'node:test';

import { queryClient } from '../../query/client.js';
import { activateSurface } from '../activation.js';
import type { WorkspaceData } from '../model.js';
import { commitDeleteSurfaceSuccess } from '../queries.js';
import { surfaceDetailQueryKey, workspaceQueryKey } from '../query-keys.js';
import { useWorkspaceStore } from '../store.js';
import { project } from './test-support.js';

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
