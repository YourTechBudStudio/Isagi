import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { QueryClient } from '@tanstack/react-query';

import type { WorkspaceSnapshot } from '@isagi/contracts';

import { useToastStore } from '../../toast/store.js';
import { workspaceDataFromSnapshot, type WorkspaceData } from '../model.js';
import { loadWorkspaceData } from '../queries.js';
import { workspaceQueryKey } from '../query-keys.js';
import { commitRailMove } from '../rail-order-commit.js';
import { useRailOrderStore } from '../rail-order-state.js';
import { applyRailMove, type RailMoveIntent } from '../rail-order.js';

/**
 * The rest of the reorder suite injects persistence so the workflow can be
 * tested without a network. This file deliberately does not: it drives
 * `commitRailMove` and the workspace query through the real runtime client, so
 * an endpoint, method, or anchor field that drifts fails here rather than
 * looking correct all the way to the runtime's door.
 *
 * The runtime URL normally comes from the Electron bridge, so the bridge is
 * stubbed for the whole file. `node:test` runs each file in its own process, so
 * this global stays local to this suite.
 */
Object.assign(globalThis, {
  window: { isagi: { getRuntimeUrl: () => Promise.resolve('http://runtime.test') } },
});

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

const snapshot = {
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
        {
          id: 12,
          projectId: 1,
          title: 'reorder',
          path: '/repo/isagi/.worktrees/reorder',
          branch: 'reorder',
          head: 'abcdef1',
          isRoot: false,
          parked: false,
          surfaces: [
            { id: 121, title: 'one', paneKinds: [] },
            { id: 122, title: 'two', paneKinds: [] },
            { id: 123, title: 'three', paneKinds: [] },
          ],
          activeSurfaceId: null,
        },
        {
          id: 13,
          projectId: 1,
          title: 'other',
          path: '/repo/isagi/.worktrees/other',
          branch: 'other',
          head: 'abcdef2',
          isRoot: false,
          parked: false,
          surfaces: [],
          activeSurfaceId: null,
        },
      ],
    },
    {
      id: 2,
      name: 'atlas',
      rootPath: '/repo/atlas',
      status: 'present',
      worktrees: [],
    },
  ],
} satisfies WorkspaceSnapshot;

const originalFetch = globalThis.fetch;

function seededClient() {
  const client = new QueryClient();
  client.setQueryData<WorkspaceData>(workspaceQueryKey, workspaceDataFromSnapshot(snapshot));
  return client;
}

function surfaceIds(client: QueryClient) {
  const owner = client
    .getQueryData<WorkspaceData>(workspaceQueryKey)
    ?.projects.flatMap((project) => project.worktrees)
    .find((worktree) => worktree.id === 12);
  return owner?.surfaces.map((entry) => entry.id) ?? [];
}

function projectIds(client: QueryClient) {
  return client.getQueryData<WorkspaceData>(workspaceQueryKey)?.projects.map((p) => p.id) ?? [];
}

/**
 * A move the test settles by hand. `started` resolves once the commit has
 * actually reached the network step, which is what makes an overlap
 * deterministic rather than timer-raced.
 */
function deferredMove() {
  let settleMove!: () => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const move = (_intent: RailMoveIntent) =>
    new Promise<unknown>((resolve) => {
      settleMove = () => resolve({});
      signalStarted();
    });
  return { move, started, settle: () => settleMove() };
}

/** Record every request and answer it with the given envelope payload. */
function recordingFetch(requests: RecordedRequest[], data: unknown) {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
    });
    return Promise.resolve(
      new Response(JSON.stringify({ data, meta: { requestId: `req-${requests.length}` } }), {
        status: 200,
      }),
    );
  }) as typeof fetch;
}

beforeEach(() => {
  useRailOrderStore.setState({ entriesByScope: {} });
  useToastStore.getState().clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('a surface drop reaches the surface order endpoint with its anchor', async () => {
  const requests: RecordedRequest[] = [];
  recordingFetch(requests, { worktreeId: 12, surfaceId: 123 });
  const client = seededClient();

  const outcome = await commitRailMove({
    intent: { scope: { kind: 'surfaces', worktreeId: 12 }, movedId: 123, beforeId: 121 },
    client,
  });

  assert.equal(outcome, 'committed');
  assert.deepEqual(requests, [
    {
      url: 'http://runtime.test/api/v1/worktrees/12/surfaces/123/order',
      method: 'PUT',
      body: JSON.stringify({ beforeSurfaceId: 121 }),
    },
  ]);
});

test('a worktree drop names its project in the path and its anchor in the body', async () => {
  const requests: RecordedRequest[] = [];
  recordingFetch(requests, { projectId: 1, worktreeId: 13 });
  const client = seededClient();

  const outcome = await commitRailMove({
    intent: { scope: { kind: 'worktrees', projectId: 1 }, movedId: 13, beforeId: 12 },
    client,
  });

  assert.equal(outcome, 'committed');
  assert.deepEqual(requests, [
    {
      url: 'http://runtime.test/api/v1/projects/1/worktrees/13/order',
      method: 'PUT',
      body: JSON.stringify({ beforeWorktreeId: 12 }),
    },
  ]);
});

test('a project drop to the end sends a null anchor', async () => {
  const requests: RecordedRequest[] = [];
  recordingFetch(requests, { projectId: 1 });
  const client = seededClient();

  const outcome = await commitRailMove({
    intent: { scope: { kind: 'projects' }, movedId: 1, beforeId: null },
    client,
  });

  assert.equal(outcome, 'committed');
  assert.deepEqual(requests, [
    {
      url: 'http://runtime.test/api/v1/projects/1/order',
      method: 'PUT',
      body: JSON.stringify({ beforeProjectId: null }),
    },
  ]);
});

test('a runtime refusal over the real transport rolls back and reports inline', async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            code: 'surface_order_rejected',
            status: 400,
            message: 'surface 123 does not belong to worktree 12',
            requestId: 'req-refused',
            data: {
              reason: 'surface_worktree_mismatch',
              worktreeId: 12,
              surfaceId: 123,
              beforeSurfaceId: 121,
            },
          },
        }),
        { status: 400 },
      ),
    )) as typeof fetch;
  const client = seededClient();

  const outcome = await commitRailMove({
    intent: { scope: { kind: 'surfaces', worktreeId: 12 }, movedId: 123, beforeId: 121 },
    client,
  });

  assert.equal(outcome, 'failed');
  assert.deepEqual(surfaceIds(client), [121, 122, 123]);
  assert.deepEqual(useRailOrderStore.getState().entriesByScope['surfaces:12'], {
    status: 'failed',
    movedId: 123,
    message: "Couldn't save that order.",
  });
});

test('a workspace refresh that lands mid-write keeps the pending order on screen', async () => {
  const requests: RecordedRequest[] = [];
  recordingFetch(requests, snapshot);
  const client = seededClient();

  // Settled by hand, so the refresh below is guaranteed to arrive while the
  // write is still outstanding.
  const surfaces = deferredMove();
  const running = commitRailMove({
    intent: { scope: { kind: 'surfaces', worktreeId: 12 }, movedId: 123, beforeId: 121 },
    client,
    move: surfaces.move,
  });
  await surfaces.started;
  assert.deepEqual(surfaceIds(client), [123, 121, 122]);

  // Something else entirely — a runtime session event, reconciliation finishing —
  // refetches the shared snapshot, and the runtime answers with the pre-move
  // order because the reorder has not been persisted yet.
  await client.fetchQuery({ queryKey: workspaceQueryKey, queryFn: () => loadWorkspaceData() });

  assert.deepEqual(surfaceIds(client), [123, 121, 122]);
  surfaces.settle();
  assert.equal(await running, 'committed');
});

test('a stale response cannot erase an accepted move while another scope is pending', async () => {
  const client = seededClient();
  let signalFetchStarted!: () => void;
  let releaseResponse!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    signalFetchStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  globalThis.fetch = (() => {
    signalFetchStarted();
    return released.then(
      () =>
        new Response(JSON.stringify({ data: snapshot, meta: { requestId: 'req-stale' } }), {
          status: 200,
        }),
    );
  }) as typeof fetch;

  const projects = deferredMove();
  const surfaces = deferredMove();
  const projectRun = commitRailMove({
    intent: { scope: { kind: 'projects' }, movedId: 2, beforeId: 1 },
    client,
    move: projects.move,
  });
  await projects.started;
  const surfaceRun = commitRailMove({
    intent: { scope: { kind: 'surfaces', worktreeId: 12 }, movedId: 123, beforeId: 121 },
    client,
    move: surfaces.move,
  });
  await surfaces.started;
  assert.deepEqual(projectIds(client), [2, 1]);
  assert.deepEqual(surfaceIds(client), [123, 121, 122]);

  // An unrelated refresh reads the runtime *before* either move is accepted, so
  // its answer carries the original order for both scopes.
  const stale = client
    .fetchQuery({ queryKey: workspaceQueryKey, queryFn: ({ signal }) => loadWorkspaceData(signal) })
    .catch(() => 'discarded');
  await fetchStarted;

  // The project move is accepted, so its intent stops being replayed — but the
  // surface move is still pending, so this settlement defers the shared refresh.
  projects.settle();
  assert.equal(await projectRun, 'committed');

  releaseResponse();
  await stale;

  // The stale answer must not undo the move the runtime has already accepted.
  assert.deepEqual(projectIds(client), [2, 1]);
  assert.deepEqual(surfaceIds(client), [123, 121, 122]);

  surfaces.settle();
  assert.equal(await surfaceRun, 'committed');
  assert.deepEqual(projectIds(client), [2, 1]);
});

test('a workspace refresh with nothing pending installs the runtime order verbatim', async () => {
  const requests: RecordedRequest[] = [];
  recordingFetch(requests, snapshot);
  const client = seededClient();
  // A stale local order, left behind by a move that has already settled.
  client.setQueryData<WorkspaceData>(workspaceQueryKey, (data) =>
    data
      ? applyRailMove(data, {
          scope: { kind: 'surfaces', worktreeId: 12 },
          movedId: 123,
          beforeId: 121,
        })
      : data,
  );
  assert.deepEqual(surfaceIds(client), [123, 121, 122]);

  await client.fetchQuery({ queryKey: workspaceQueryKey, queryFn: () => loadWorkspaceData() });

  assert.deepEqual(surfaceIds(client), [121, 122, 123]);
});
