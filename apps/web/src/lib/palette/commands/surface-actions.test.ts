import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionStatus, SurfaceDetail } from '@isagi/contracts';

import { queryClient } from '../../query/client.js';
import { formatRuntimeError } from '../../workspace/runtime-data.js';
import {
  deleteActivePaneCommand,
  deleteActiveSurfaceCommand,
  renameActiveSurfaceCommand,
} from './surface-actions.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  queryClient.clear();
  Reflect.deleteProperty(globalThis, 'window');
});

test('delete-active-pane preflight falls back to the first pane when no active pane is stored', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      isagi: {
        getRuntimeUrl: () => Promise.resolve('http://runtime.test'),
      },
    },
  });
  globalThis.fetch = mockJsonFetch(surfaceDetail({ activePaneId: null }));

  const preflight = await deleteActivePaneCommand.preflight?.(
    {
      projects: [],
      launchableHarnesses: [],
      activeProject: null,
      activeWorktree: {
        id: 10,
        projectId: 1,
        title: 'main',
        path: '/repo/isagi',
        branch: 'main',
        head: 'abcdef0',
        isRoot: true,
        attention: 'idle',
        parked: false,
        surfaces: [
          { id: 501, title: 'Terminal', paneKinds: ['terminal_session'], attention: 'idle' },
        ],
        activeSurfaceId: 501,
      },
      activeSurface: {
        id: 501,
        title: 'Terminal',
        paneKinds: ['terminal_session'],
        attention: 'idle',
      },
      activePaneId: null,
    },
    {},
  );

  assert.deepEqual(preflight, {
    mode: 'run',
    values: { worktreeId: '10', surfaceId: '501', paneId: '601' },
  });
});

test('rename-active-surface validation surfaces inline copy', async () => {
  let error: unknown;
  try {
    await renameActiveSurfaceCommand.run(
      { surfaceId: '501', title: '   ' },
      {
        projects: [],
        launchableHarnesses: [],
        activeProject: null,
        activeWorktree: null,
        activeSurface: {
          id: 501,
          title: 'Terminal',
          paneKinds: ['terminal_session'],
          attention: 'idle',
        },
        activePaneId: null,
      },
    );
  } catch (cause) {
    error = cause;
  }

  assert.equal(formatRuntimeError(error), 'Surface title cannot be empty.');
});

test('delete-active-pane preflight runs directly for a running fallback pane', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      isagi: {
        getRuntimeUrl: () => Promise.resolve('http://runtime.test'),
      },
    },
  });
  globalThis.fetch = mockJsonFetch(
    surfaceDetail({ activePaneId: 602, firstStatus: 'exited', secondStatus: 'running' }),
  );

  const preflight = await deleteActivePaneCommand.preflight?.(
    {
      projects: [],
      launchableHarnesses: [],
      activeProject: null,
      activeWorktree: {
        id: 10,
        projectId: 1,
        title: 'main',
        path: '/repo/isagi',
        branch: 'main',
        head: 'abcdef0',
        isRoot: true,
        attention: 'idle',
        parked: false,
        surfaces: [
          { id: 501, title: 'Terminal', paneKinds: ['terminal_session'], attention: 'idle' },
        ],
        activeSurfaceId: 501,
      },
      activeSurface: {
        id: 501,
        title: 'Terminal',
        paneKinds: ['terminal_session'],
        attention: 'idle',
      },
      activePaneId: null,
    },
    {},
  );

  assert.deepEqual(preflight, {
    mode: 'run',
    values: { worktreeId: '10', surfaceId: '501', paneId: '602' },
  });
});

test('delete-active-surface preflight runs directly without loading session status', async () => {
  globalThis.fetch = (() => {
    throw new Error('delete-active-surface preflight should not fetch surface detail');
  }) as typeof fetch;

  const preflight = await deleteActiveSurfaceCommand.preflight?.(
    {
      projects: [],
      launchableHarnesses: [],
      activeProject: null,
      activeWorktree: {
        id: 10,
        projectId: 1,
        title: 'main',
        path: '/repo/isagi',
        branch: 'main',
        head: 'abcdef0',
        isRoot: true,
        attention: 'idle',
        parked: false,
        surfaces: [
          { id: 501, title: 'Terminal', paneKinds: ['terminal_session'], attention: 'idle' },
        ],
        activeSurfaceId: 501,
      },
      activeSurface: {
        id: 501,
        title: 'Terminal',
        paneKinds: ['terminal_session'],
        attention: 'idle',
      },
      activePaneId: 601,
    },
    {},
  );

  assert.deepEqual(preflight, {
    mode: 'run',
    values: { worktreeId: '10', surfaceId: '501' },
  });
});

function mockJsonFetch(data: SurfaceDetail) {
  return ((input) => {
    assert.equal(String(input), 'http://runtime.test/api/v1/surfaces/501');
    return Promise.resolve(
      new Response(JSON.stringify({ data, meta: { requestId: 'surface-detail' } }), {
        status: 200,
      }),
    );
  }) as typeof fetch;
}

function surfaceDetail({
  activePaneId,
  firstStatus = 'exited',
  secondStatus = 'exited',
}: {
  readonly activePaneId: number | null;
  readonly firstStatus?: SessionStatus;
  readonly secondStatus?: SessionStatus;
}): SurfaceDetail {
  return {
    id: 501,
    worktreeId: 10,
    title: 'Terminal',
    activePaneId,
    layout: { kind: 'leaf', nodeId: 'pane-601', paneId: 601, collapsed: false },
    panes: [
      {
        id: 601,
        surfaceId: 501,
        title: 'Terminal',
        sortOrder: 0,
        session: terminalSession(601, firstStatus),
      },
      {
        id: 602,
        surfaceId: 501,
        title: 'Terminal 2',
        sortOrder: 1,
        session: terminalSession(602, secondStatus),
      },
    ],
  };
}

function terminalSession(paneId: number, status: SessionStatus) {
  return {
    kind: 'terminal_session',
    terminalSession: {
      id: paneId + 100,
      paneId,
      worktreeId: 10,
      cwd: '/repo/isagi',
      shellCommand: 'zsh',
      shellArgs: [],
      status,
      statusReason: null,
      diagnosticCode: null,
      diagnosticDetail: null,
      createdAt: '2026-06-14T00:00:00.000Z',
      updatedAt: '2026-06-14T00:00:00.000Z',
      lastSeenAt: null,
    },
  } satisfies NonNullable<SurfaceDetail['panes'][number]['session']>;
}
