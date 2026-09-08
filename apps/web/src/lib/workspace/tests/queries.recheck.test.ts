import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient } from '@tanstack/react-query';

import type { WorkspaceData } from '../model.js';
import { runProjectRecheck } from '../queries.js';
import { activeContextQueryKey, workspaceQueryKey } from '../query-keys.js';
import {
  subscribeTerminalWorkspaceFacts,
  type TerminalWorkspaceFact,
} from '../terminal-presentation/coordinator-events.js';
import { project, workspace } from './test-support.js';

const FOLDER = 7;

function missingWorkspace(): WorkspaceData {
  return workspace([project({ id: FOLDER, name: 'notes', kind: 'folder', status: 'missing' })]);
}

function presentWorkspace(): WorkspaceData {
  return workspace([project({ id: FOLDER, name: 'notes', kind: 'folder' })]);
}

/** Collects inventory facts for the duration of one test. */
function recordFacts() {
  const facts: TerminalWorkspaceFact[] = [];
  const unsubscribe = subscribeTerminalWorkspaceFacts((fact) => facts.push(fact));
  return { facts, unsubscribe };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

test('a reconcile that restores the folder settles as restored', async () => {
  const client = new QueryClient();
  client.setQueryData<WorkspaceData>(workspaceQueryKey, missingWorkspace());
  const seen: number[] = [];

  const result = await runProjectRecheck({
    client,
    projectId: FOLDER,
    reconcile: async (projectId) => {
      seen.push(projectId);
    },
    fetchWorkspaceData: async () => presentWorkspace(),
  });

  assert.deepEqual(result, { status: 'restored', projectId: FOLDER });
  // The reconcile is scoped to the project the user is looking at, never a global sweep.
  assert.deepEqual(seen, [FOLDER]);
  client.clear();
});

test('a folder that is genuinely still absent settles as still_unavailable', async () => {
  const client = new QueryClient();
  client.setQueryData<WorkspaceData>(workspaceQueryKey, missingWorkspace());

  const result = await runProjectRecheck({
    client,
    projectId: FOLDER,
    reconcile: async () => {},
    fetchWorkspaceData: async () => missingWorkspace(),
  });

  assert.deepEqual(result, { status: 'still_unavailable', projectId: FOLDER });
  client.clear();
});

test('a project absent from the fresh snapshot is still_unavailable, not restored', async () => {
  const client = new QueryClient();

  const result = await runProjectRecheck({
    client,
    projectId: FOLDER,
    reconcile: async () => {},
    fetchWorkspaceData: async () => workspace([]),
  });

  assert.deepEqual(result, { status: 'still_unavailable', projectId: FOLDER });
  client.clear();
});

test('a failed reconcile rejects and never reads the workspace', async () => {
  const client = new QueryClient();
  client.setQueryData<WorkspaceData>(workspaceQueryKey, missingWorkspace());
  const recorded = recordFacts();
  let reads = 0;

  await assert.rejects(
    runProjectRecheck({
      client,
      projectId: FOLDER,
      reconcile: async () => {
        throw new Error('reconcile refused');
      },
      fetchWorkspaceData: async () => {
        reads += 1;
        return presentWorkspace();
      },
    }),
    /reconcile refused/,
  );

  assert.equal(reads, 0);
  assert.deepEqual(recorded.facts, []);
  recorded.unsubscribe();
  client.clear();
});

test('a failed read after a successful reconcile rejects, and never reports absence', async () => {
  const client = new QueryClient();
  // The dangerous starting point: the cache still says missing, so anything that
  // fell back to it would answer "still not there" on a read that never happened.
  client.setQueryData<WorkspaceData>(workspaceQueryKey, missingWorkspace());
  const recorded = recordFacts();

  await assert.rejects(
    runProjectRecheck({
      client,
      projectId: FOLDER,
      reconcile: async () => {},
      fetchWorkspaceData: async () => {
        throw new Error('the runtime dropped the read');
      },
    }),
    /the runtime dropped the read/,
  );

  // No verdict, and no inventory fact: the refresh never succeeded, so nothing
  // downstream should be told the inventory is worth re-reading.
  assert.deepEqual(recorded.facts, []);
  recorded.unsubscribe();
  client.clear();
});

test('a fresh read is performed even when the cache already holds a missing snapshot', async () => {
  const client = new QueryClient();
  client.setQueryData<WorkspaceData>(workspaceQueryKey, missingWorkspace());
  let reads = 0;

  const result = await runProjectRecheck({
    client,
    projectId: FOLDER,
    reconcile: async () => {},
    fetchWorkspaceData: async () => {
      reads += 1;
      return presentWorkspace();
    },
  });

  // `staleTime: 0` is what stops a cached missing snapshot from settling as a
  // successful negative result without the runtime being asked at all.
  assert.equal(reads, 1);
  assert.deepEqual(result, { status: 'restored', projectId: FOLDER });
  assert.deepEqual(client.getQueryData<WorkspaceData>(workspaceQueryKey), presentWorkspace());
  client.clear();
});

test('the inventory fact is published exactly once, after the successful read', async () => {
  const client = new QueryClient();
  const order: string[] = [];
  const unsubscribe = subscribeTerminalWorkspaceFacts((fact) => order.push(`fact:${fact.type}`));

  await runProjectRecheck({
    client,
    projectId: FOLDER,
    reconcile: async () => {
      order.push('reconcile');
    },
    fetchWorkspaceData: async () => {
      order.push('read');
      return presentWorkspace();
    },
  });

  assert.deepEqual(order, ['reconcile', 'read', 'fact:durable_inventory_refresh_requested']);
  unsubscribe();
  client.clear();
});

/**
 * The defect this operation's cancellation exists for.
 *
 * `Query.fetch` returns the in-flight retryer promise when a fetch is already
 * running, and `staleTime` has no say over that — so without the cancel, the
 * post-reconcile `fetchQuery` is handed a read that started *before* the
 * reconcile, and a folder that genuinely came back is reported as still absent.
 */
test(
  'a read already in flight before the reconcile cannot supply the verdict',
  { timeout: 5_000 },
  async () => {
    const client = new QueryClient();
    const stale = deferred<WorkspaceData>();
    const reads: string[] = [];

    // A pre-reconcile read, exactly as a window-focus refetch would leave in
    // flight while the user clicks Check again. It answers with the *pre*-reconcile
    // world: the folder still missing.
    const staleRead = client
      .fetchQuery({
        queryKey: workspaceQueryKey,
        queryFn: () => {
          reads.push('stale');
          return stale.promise;
        },
        staleTime: 0,
      })
      .catch(() => 'cancelled');

    await Promise.resolve();
    assert.deepEqual(reads, ['stale']);

    // Let the stale read finish shortly *after* the recheck reaches its own fetch.
    // Without the cancellation the recheck is handed this promise instead of
    // issuing its own read, and settles on the folder still being missing — which
    // fails the two assertions below rather than hanging the suite.
    const staleLanded = new Promise<void>((resolve) =>
      setTimeout(() => {
        stale.resolve(missingWorkspace());
        resolve();
      }, 20),
    );

    const result = await runProjectRecheck({
      client,
      projectId: FOLDER,
      reconcile: async () => {},
      fetchWorkspaceData: async () => {
        reads.push('fresh');
        return presentWorkspace();
      },
    });

    // The verdict came from a read that began after the reconcile, not from the
    // one that was already running.
    assert.deepEqual(reads, ['stale', 'fresh']);
    assert.deepEqual(result, { status: 'restored', projectId: FOLDER });

    // The cancelled read completing late must not overwrite the fresh value. The
    // runtime may well have finished its work — cancellation is client-side — so
    // this is the property that actually matters.
    await staleLanded;
    await staleRead;
    await Promise.resolve();
    assert.deepEqual(client.getQueryData<WorkspaceData>(workspaceQueryKey), presentWorkspace());
    client.clear();
  },
);

test('the cancellation leaves the active-context query alone', async () => {
  const client = new QueryClient();
  const activeContext = deferred<{ readonly projectId: number | null }>();
  let activeContextSettled: string | null = null;

  const activeContextRead = client
    .fetchQuery({
      queryKey: activeContextQueryKey,
      queryFn: () => activeContext.promise,
      staleTime: 0,
    })
    .then(
      () => {
        activeContextSettled = 'resolved';
      },
      () => {
        activeContextSettled = 'cancelled';
      },
    );

  const staleWorkspace = deferred<WorkspaceData>();
  const staleRead = client
    .fetchQuery({
      queryKey: workspaceQueryKey,
      queryFn: () => staleWorkspace.promise,
      staleTime: 0,
    })
    .catch(() => 'cancelled');

  await runProjectRecheck({
    client,
    projectId: FOLDER,
    reconcile: async () => {},
    fetchWorkspaceData: async () => presentWorkspace(),
  });

  // `workspaceQueryKey` is ['workspace'] and `activeContextQueryKey` is
  // ['workspace', 'active-context'], so a non-exact cancel would abort this
  // unrelated live request.
  assert.equal(activeContextSettled, null);
  activeContext.resolve({ projectId: 1 });
  staleWorkspace.resolve(missingWorkspace());
  await Promise.all([activeContextRead, staleRead]);
  assert.equal(activeContextSettled, 'resolved');
  client.clear();
});
