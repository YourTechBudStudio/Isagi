import assert from 'node:assert/strict';
import test from 'node:test';

import type { DeleteWorktreeOutput, WorkspaceSnapshot } from '@isagi/contracts';

import { queryClient } from '../../query/client.js';
import type { PaletteContext } from '../types.js';
import { deleteActiveWorktreeCommand } from './worktree-actions.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  queryClient.clear();
  Reflect.deleteProperty(globalThis, 'window');
});

test('delete-active-worktree is hidden for the root active worktree', () => {
  assert.equal(deleteActiveWorktreeCommand.available?.(ctx({ activeIsRoot: true })), false);
  assert.equal(deleteActiveWorktreeCommand.available?.(ctx({ activeIsRoot: false })), true);
});

test('delete-active-worktree preflight freezes explicit target values', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { isagi: { getRuntimeUrl: () => Promise.resolve('http://runtime.test') } },
  });
  const urls: string[] = [];
  globalThis.fetch = ((input) => {
    urls.push(String(input));
    return Promise.resolve(
      jsonResponse({
        projectId: 1,
        worktreeId: 11,
        path: '/repo/isagi-feature',
        branch: 'feature/delete-me',
        isRoot: false,
        dirty: true,
      }),
    );
  }) as typeof fetch;

  const preflight = await deleteActiveWorktreeCommand.preflight?.(
    ctx({ activeProjectId: 2, activeWorktreeId: 22, activeIsRoot: false }),
    { projectId: '1', worktreeId: '11' },
  );

  assert.equal(urls[0], 'http://runtime.test/api/v1/projects/1/worktrees/11/delete/preflight');
  assert.deepEqual(preflight, {
    mode: 'palette',
    values: {
      projectId: '1',
      worktreeId: '11',
      path: '/repo/isagi-feature',
      branch: 'feature/delete-me',
      dirty: 'true',
      isRoot: 'false',
    },
  });
});

test('delete-active-worktree hides branch delete option for detached worktrees', async () => {
  const modeStep = deleteActiveWorktreeCommand.args?.[1];
  assert.equal(modeStep?.kind, 'select');
  if (modeStep?.kind !== 'select') {
    return;
  }

  const options = await modeStep.options(ctx({ activeIsRoot: false }), { branch: '' });
  assert.deepEqual(
    options.map((option) => option.value),
    ['checkout-only'],
  );
});

test('delete-active-worktree renders branch failure as a palette result', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { isagi: { getRuntimeUrl: () => Promise.resolve('http://runtime.test') } },
  });
  globalThis.fetch = mockDeleteFetch({
    projectId: 1,
    deletedWorktreeId: 11,
    selectedWorktreeId: 10,
    branchRemoval: {
      status: 'failed',
      branch: 'feature/delete-me',
      diagnostic: 'error: branch is not fully merged',
    },
  });

  const outcome = await deleteActiveWorktreeCommand.run(
    {
      projectId: '1',
      worktreeId: '11',
      dirty: 'false',
      deleteMode: 'checkout-and-branch',
      isRoot: 'false',
    },
    ctx({ activeIsRoot: false }),
  );

  assert.equal(outcome?.kind, 'result');
  assert.equal(
    outcome?.kind === 'result' ? outcome.content.title : '',
    'Checkout deleted. Branch was not deleted.',
  );
  assert.equal(
    outcome?.kind === 'result' ? outcome.content.diagnostic?.detail : '',
    'error: branch is not fully merged',
  );
});

function mockDeleteFetch(output: DeleteWorktreeOutput) {
  return ((input, init) => {
    const url = String(input);
    if (url === 'http://runtime.test/api/v1/projects/1/worktrees/11') {
      assert.equal(init?.method, 'DELETE');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        checkoutRemovalMode: 'normal',
        branchRemovalMode: 'delete_if_safe',
      });
      return Promise.resolve(jsonResponse(output));
    }
    if (url === 'http://runtime.test/api/v1/workspace') {
      return Promise.resolve(jsonResponse(workspaceSnapshot()));
    }
    throw new Error(`Unexpected fetch ${url}`);
  }) as typeof fetch;
}

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify({ data, meta: { requestId: 'test' } }), { status: 200 });
}

function workspaceSnapshot(): WorkspaceSnapshot {
  return {
    projects: [
      {
        id: 1,
        name: 'isagi',
        rootPath: '/repo/isagi',
        status: 'present',
        worktrees: [
          {
            id: 10,
            projectId: 1,
            title: 'main',
            path: '/repo/isagi',
            branch: 'main',
            head: 'abcdef0',
            isRoot: true,
            parked: false,
            surfaces: [],
            activeSurfaceId: null,
          },
        ],
      },
    ],
  };
}

function ctx(input: {
  readonly activeIsRoot: boolean;
  readonly activeProjectId?: number;
  readonly activeWorktreeId?: number;
}): PaletteContext {
  const projectId = input.activeProjectId ?? 1;
  const worktreeId = input.activeWorktreeId ?? 11;
  return {
    projects: [],
    activeProject: {
      id: projectId,
      name: 'isagi',
      rootPath: '/repo/isagi',
      glyph: 'IS',
      accent: 'blue',
      status: 'present',
      worktrees: [],
    },
    activeWorktree: {
      id: worktreeId,
      projectId,
      title: input.activeIsRoot ? 'main' : 'feature/delete-me',
      path: input.activeIsRoot ? '/repo/isagi' : '/repo/isagi-feature',
      branch: input.activeIsRoot ? 'main' : 'feature/delete-me',
      head: 'abcdef0',
      isRoot: input.activeIsRoot,
      attention: 'idle',
      parked: false,
      surfaces: [],
      activeSurfaceId: null,
    },
    activeSurface: null,
    activePaneId: null,
    launchableHarnesses: [],
  };
}
