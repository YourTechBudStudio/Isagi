import assert from 'node:assert/strict';
import test from 'node:test';

import type { PtySessionStatus, SurfaceDetail } from '@isagi/contracts';

import { queryClient } from '../../query/client.js';
import { formatRuntimeError } from '../../workspace/runtime-data.js';
import { deleteActivePaneCommand, renameActiveSurfaceCommand } from './surface-actions.js';

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
        surfaces: [{ id: 501, kind: 'terminal', title: 'Terminal', attention: 'idle' }],
        activeSurfaceId: 501,
        commands: [],
      },
      activeSurface: { id: 501, kind: 'terminal', title: 'Terminal', attention: 'idle' },
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
        activeProject: null,
        activeWorktree: null,
        activeSurface: { id: 501, kind: 'terminal', title: 'Terminal', attention: 'idle' },
        activePaneId: null,
      },
    );
  } catch (cause) {
    error = cause;
  }

  assert.equal(formatRuntimeError(error), 'Surface title cannot be empty.');
});

test('delete-active-pane preflight opens review for a running fallback pane', async () => {
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
        surfaces: [{ id: 501, kind: 'terminal', title: 'Terminal', attention: 'idle' }],
        activeSurfaceId: 501,
        commands: [],
      },
      activeSurface: { id: 501, kind: 'terminal', title: 'Terminal', attention: 'idle' },
      activePaneId: null,
    },
    {},
  );

  assert.deepEqual(preflight, {
    mode: 'palette',
    values: { worktreeId: '10', surfaceId: '501', paneId: '602' },
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
  readonly firstStatus?: PtySessionStatus;
  readonly secondStatus?: PtySessionStatus;
}): SurfaceDetail {
  return {
    id: 501,
    worktreeId: 10,
    kind: 'terminal',
    title: 'Terminal',
    attention: 'idle',
    activePaneId,
    layout: { kind: 'leaf', nodeId: 'pane-601', paneId: 601, collapsed: false },
    panes: [
      {
        id: 601,
        surfaceId: 501,
        title: 'Terminal',
        attention: 'idle',
        sortOrder: 0,
        ptySession: session(601, firstStatus),
      },
      {
        id: 602,
        surfaceId: 501,
        title: 'Terminal 2',
        attention: 'idle',
        sortOrder: 1,
        ptySession: session(602, secondStatus),
      },
    ],
  };
}

function session(paneId: number, status: PtySessionStatus) {
  return {
    id: paneId + 100,
    paneId,
    worktreeId: 10,
    backend: 'node_pty',
    purpose: 'terminal',
    harness: null,
    command: 'zsh',
    cwd: '/repo/isagi',
    status,
    statusReason: null,
    exitCode: status === 'exited' ? 0 : null,
    signal: null,
    logMode: 'backend_file',
    createdAt: '2026-06-14T00:00:00.000Z',
    updatedAt: '2026-06-14T00:00:00.000Z',
    exitedAt: status === 'exited' ? '2026-06-14T00:00:00.000Z' : null,
    lastSeenAt: null,
  } satisfies NonNullable<SurfaceDetail['panes'][number]['ptySession']>;
}
