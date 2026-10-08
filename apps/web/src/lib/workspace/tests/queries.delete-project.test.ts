import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient } from '@tanstack/react-query';
import { Effect } from 'effect';

import type { DeleteProjectOutput } from '@isagi/contracts';

import { toastCopy } from '../../../copy/index.js';
import { clearToasts, useToastStore } from '../../toast/index.js';
import { defaultSelection, reconcileSelection, type WorkspaceData } from '../model.js';
import { commitDeleteProjectSuccess, deleteProjectFromPalette } from '../queries.js';
import { workspaceQueryKey } from '../query-keys.js';
import { emptyWorkspaceSelection, useWorkspaceStore } from '../store.js';
import {
  subscribeTerminalWorkspaceFacts,
  type TerminalWorkspaceFact,
} from '../terminal-presentation/coordinator-events.js';
import type { WorkspaceSelection } from '../types.js';
import { project, worktree } from './test-support.js';

/**
 * The project-delete data path: one runtime call, the existing failure toast,
 * and a success commit that moves the selection itself so background
 * reconciliation never mistakes a deliberate delete for a vanished checkout.
 */

const doomed = project({
  id: 1,
  name: 'doomed',
  worktrees: [worktree({ id: 10, projectId: 1, isRoot: true }), worktree({ id: 11, projectId: 1 })],
});
const missingSibling = project({ id: 2, name: 'gone-elsewhere', status: 'missing' });
const healthy = project({ id: 3, name: 'healthy' });

test.afterEach(() => {
  clearToasts();
  useWorkspaceStore.getState().setSelection(emptyWorkspaceSelection);
});

test('success announces the cached worktrees before the refetch replaces them', async () => {
  const client = seededClient([doomed, healthy]);
  const events: string[] = [];
  const stop = recordFacts(events);

  await commitDeleteProjectSuccess(client, 1, async () => {
    events.push('fetch');
    return { projects: [healthy] };
  });
  stop();

  assert.deepEqual(events, [
    'durable_worktree_deleted:10',
    'durable_worktree_deleted:11',
    'fetch',
    'durable_inventory_refresh_requested',
  ]);
  assert.deepEqual(
    client.getQueryData<WorkspaceData>(workspaceQueryKey)?.projects.map(({ id }) => id),
    [3],
  );
});

for (const selection of [
  { kind: 'worktree', projectId: 1, worktreeId: 11 },
  { kind: 'missingProject', projectId: 1 },
] as const satisfies readonly WorkspaceSelection[]) {
  test(`a ${selection.kind} selection on the deleted project moves to the default`, async () => {
    const fresh = [missingSibling, healthy];
    useWorkspaceStore.getState().setSelection(selection);

    await commitDeleteProjectSuccess(seededClient([doomed, ...fresh]), 1, async () => ({
      projects: fresh,
    }));

    const next = useWorkspaceStore.getState().selection;
    assert.deepEqual(next, defaultSelection(fresh));
    assert.deepEqual(next, { kind: 'missingProject', projectId: 2 });
    assertReconcileIsQuiet(fresh, next);
  });
}

test('a worktree selection lands on the next healthy root with no recovery warning', async () => {
  const fresh = [healthy];
  useWorkspaceStore.getState().setSelection({ kind: 'worktree', projectId: 1, worktreeId: 10 });

  await commitDeleteProjectSuccess(seededClient([doomed, healthy]), 1, async () => ({
    projects: fresh,
  }));

  const next = useWorkspaceStore.getState().selection;
  assert.deepEqual(next, { kind: 'worktree', projectId: 3, worktreeId: 30 });
  // `useReconcileSelection` raises `active-worktree-recovered:*` only when it has
  // to change a worktree selection. Already reconciled, it has nothing to do.
  assertReconcileIsQuiet(fresh, next);
});

test('a selection on another project is left alone', async () => {
  const elsewhere = { kind: 'worktree', projectId: 3, worktreeId: 30 } as const;
  useWorkspaceStore.getState().setSelection(elsewhere);

  await commitDeleteProjectSuccess(seededClient([doomed, healthy]), 1, async () => ({
    projects: [healthy],
  }));

  assert.deepEqual(useWorkspaceStore.getState().selection, elsewhere);
});

test('deleting the only project leaves the empty workspace', async () => {
  useWorkspaceStore.getState().setSelection({ kind: 'worktree', projectId: 1, worktreeId: 10 });

  await commitDeleteProjectSuccess(seededClient([doomed]), 1, async () => ({ projects: [] }));

  assert.deepEqual(useWorkspaceStore.getState().selection, { kind: 'empty' });
});

/**
 * `fetchQuery` joins a read already in flight regardless of `staleTime`. One
 * that began before the delete still lists the project, so without the cancel
 * it would supply the commit's data and leave the deleted project selected.
 */
test(
  'a workspace read already in flight before the delete cannot supply the commit',
  { timeout: 5_000 },
  async () => {
    const client = seededClient([doomed, healthy]);
    useWorkspaceStore.getState().setSelection({ kind: 'worktree', projectId: 1, worktreeId: 11 });
    let resolveStale: (data: WorkspaceData) => void = () => {};
    const reads: string[] = [];

    const staleRead = client
      .fetchQuery({
        queryKey: workspaceQueryKey,
        queryFn: () => {
          reads.push('stale');
          return new Promise<WorkspaceData>((resolve) => {
            resolveStale = resolve;
          });
        },
        staleTime: 0,
      })
      .catch(() => 'cancelled');
    await Promise.resolve();

    // The pre-delete read answers shortly after the commit reaches its own fetch.
    const staleLanded = new Promise<void>((resolve) =>
      setTimeout(() => {
        resolveStale({ projects: [doomed, healthy] });
        resolve();
      }, 20),
    );

    await commitDeleteProjectSuccess(client, 1, async () => {
      reads.push('fresh');
      return { projects: [healthy] };
    });

    assert.deepEqual(reads, ['stale', 'fresh']);
    assert.deepEqual(useWorkspaceStore.getState().selection, {
      kind: 'worktree',
      projectId: 3,
      worktreeId: 30,
    });

    // The cancelled read landing late must not put the deleted project back.
    await staleLanded;
    await staleRead;
    await Promise.resolve();
    assert.deepEqual(
      client.getQueryData<WorkspaceData>(workspaceQueryKey)?.projects.map(({ id }) => id),
      [3],
    );
  },
);

test('a refused delete shows the existing toast, refreshes, and resolves', async () => {
  const client = seededClient([doomed]);
  const originalError = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => void logged.push(args[0]);
  try {
    await deleteProjectFromPalette(1, () => Effect.fail(new Error('gate refused')), client);
  } finally {
    console.error = originalError;
  }

  const toast = useToastStore.getState().toasts.find(({ id }) => id === 'delete-project-failed:1');
  assert.equal(toast?.title, toastCopy.projectDeleteFailed.title);
  assert.equal(toast?.title, 'Could not delete the project.');
  assert.deepEqual(logged, ['[workspace] project deletion failed']);
  assert.equal(client.getQueryState(workspaceQueryKey)?.isInvalidated, true);
});

test('a successful delete commits with a fresh read and shows no toast', async () => {
  const client = seededClient([doomed, healthy]);
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { isagi: { getRuntimeUrl: () => Promise.resolve('http://runtime.test') } },
  });
  const urls: string[] = [];
  globalThis.fetch = ((input) => {
    urls.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify({ data: { projects: [] }, meta: { requestId: 'test' } }), {
        status: 200,
      }),
    );
  }) as typeof fetch;
  useWorkspaceStore.getState().setSelection({ kind: 'worktree', projectId: 1, worktreeId: 11 });
  const events: string[] = [];
  const stop = recordFacts(events);
  const calls: number[] = [];

  try {
    await deleteProjectFromPalette(
      1,
      (projectId) => {
        calls.push(projectId);
        return Effect.succeed({ projectId, deleted: false } satisfies DeleteProjectOutput);
      },
      client,
    );
  } finally {
    stop();
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, 'window');
  }

  // `{ deleted: false }` is still success: the project is not there either way.
  assert.deepEqual(calls, [1]);
  assert.deepEqual(urls, ['http://runtime.test/api/v1/workspace']);
  assert.deepEqual(events, [
    'durable_worktree_deleted:10',
    'durable_worktree_deleted:11',
    'durable_inventory_refresh_requested',
  ]);
  assert.deepEqual(useWorkspaceStore.getState().selection, { kind: 'empty' });
  assert.equal(useToastStore.getState().toasts.length, 0);
});

function seededClient(projects: WorkspaceData['projects']) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });
  client.setQueryData<WorkspaceData>(workspaceQueryKey, { projects });
  return client;
}

function recordFacts(events: string[]) {
  return subscribeTerminalWorkspaceFacts((fact: TerminalWorkspaceFact) => {
    events.push(
      fact.type === 'durable_worktree_deleted' ? `${fact.type}:${fact.worktreeId}` : fact.type,
    );
  });
}

function assertReconcileIsQuiet(
  projects: WorkspaceData['projects'],
  selection: WorkspaceSelection,
) {
  assert.deepEqual(reconcileSelection(projects, selection), selection);
}
