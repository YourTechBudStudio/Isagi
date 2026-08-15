import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { QueryClient } from '@tanstack/react-query';

import type { ApiError } from '@isagi/contracts';

import { RuntimeApiError, RuntimeTransportError } from '../../runtime/errors.js';
import { useToastStore } from '../../toast/store.js';
import type { WorkspaceData } from '../model.js';
import { workspaceQueryKey } from '../query-keys.js';
import { commitRailMove } from '../rail-order-commit.js';
import { useRailOrderStore } from '../rail-order-state.js';
import type { RailMoveIntent, RailOrderScope } from '../rail-order.js';
import { useWorkspaceStore } from '../store.js';
import { project, surface, workspace, worktree } from './test-support.js';

const PROJECTS: RailOrderScope = { kind: 'projects' };
const WORKTREES: RailOrderScope = { kind: 'worktrees', projectId: 1 };
const SURFACES: RailOrderScope = { kind: 'surfaces', worktreeId: 12 };

function seed(): WorkspaceData {
  return workspace([
    project({
      id: 1,
      name: 'isagi',
      worktrees: [
        worktree({ id: 10, projectId: 1, isRoot: true }),
        worktree({ id: 11, projectId: 1 }),
        worktree({
          id: 12,
          projectId: 1,
          surfaces: [surface({ id: 121 }), surface({ id: 122 }), surface({ id: 123 })],
        }),
      ],
    }),
    project({ id: 2, name: 'atlas' }),
  ]);
}

function seededClient() {
  const client = new QueryClient();
  client.setQueryData(workspaceQueryKey, seed());
  return client;
}

function cached(client: QueryClient) {
  return client.getQueryData<WorkspaceData>(workspaceQueryKey);
}

function surfaceIds(client: QueryClient) {
  // Searched rather than indexed: a project reorder moves the owning project.
  for (const candidate of cached(client)?.projects ?? []) {
    const found = candidate.worktrees.find((entry) => entry.id === 12);
    if (found) return found.surfaces.map((entry) => entry.id);
  }
  return [];
}

function worktreeIds(client: QueryClient) {
  const owner = cached(client)?.projects.find((candidate) => candidate.id === 1);
  return owner?.worktrees.map((entry) => entry.id) ?? [];
}

function projectIds(client: QueryClient) {
  return cached(client)?.projects.map((candidate) => candidate.id) ?? [];
}

function entries() {
  return useRailOrderStore.getState().entriesByScope;
}

/** The inline refusal text at `scopeKey`, or `null` when the scope is not failed. */
function failureMessage(scopeKey: string) {
  const entry = entries()[scopeKey];
  return entry?.status === 'failed' ? entry.message : null;
}

function apiFailure(code: string, reason: string): RuntimeApiError<ApiError> {
  return new RuntimeApiError({
    code,
    status: 400,
    message: 'diagnostic',
    requestId: 'req-1',
    data: { reason },
  } as ApiError);
}

function transportFailure() {
  return new RuntimeTransportError('offline', new Error('offline'));
}

/**
 * A move whose persistence the test settles by hand. `started` resolves once the
 * commit has actually reached the network step, which is what makes the
 * two-scope overlap deterministic instead of timer-raced.
 */
function deferredMove() {
  let resolveMove!: (value: unknown) => void;
  let rejectMove!: (error: unknown) => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const move = (_intent: RailMoveIntent) =>
    new Promise<unknown>((resolve, reject) => {
      resolveMove = resolve;
      rejectMove = reject;
      signalStarted();
    });
  return {
    move,
    started,
    settle: (outcome: { readonly ok: boolean; readonly error?: unknown }) =>
      outcome.ok ? resolveMove({}) : rejectMove(outcome.error),
  };
}

beforeEach(() => {
  useRailOrderStore.setState({ entriesByScope: {} });
  useToastStore.getState().clear();
});

test('a surface move projects optimistically, persists, and refreshes', async () => {
  const client = seededClient();
  const seen: RailMoveIntent[] = [];

  const outcome = await commitRailMove({
    intent: { scope: SURFACES, movedId: 123, beforeId: 121 },
    client,
    move: (intent) => {
      // The cache already shows the new order while the write is in flight.
      assert.deepEqual(surfaceIds(client), [123, 121, 122]);
      seen.push(intent);
      return Promise.resolve({});
    },
  });

  assert.equal(outcome, 'committed');
  assert.deepEqual(surfaceIds(client), [123, 121, 122]);
  assert.equal(seen.length, 1);
  // Nothing lingers in the transient store, and the snapshot is armed to refetch.
  assert.deepEqual(entries(), {});
  assert.equal(client.getQueryState(workspaceQueryKey)?.isInvalidated, true);
});

test('a project move stays inside the present section', async () => {
  const client = seededClient();
  const outcome = await commitRailMove({
    intent: { scope: PROJECTS, movedId: 2, beforeId: 1 },
    client,
    move: () => Promise.resolve({}),
  });

  assert.equal(outcome, 'committed');
  assert.deepEqual(projectIds(client), [2, 1]);
});

test('a worktree move keeps the root pinned above the reordered siblings', async () => {
  const client = seededClient();
  const seen: RailMoveIntent[] = [];

  const outcome = await commitRailMove({
    intent: { scope: WORKTREES, movedId: 12, beforeId: 11 },
    client,
    move: (intent) => {
      seen.push(intent);
      return Promise.resolve({});
    },
  });

  assert.equal(outcome, 'committed');
  assert.deepEqual(worktreeIds(client), [10, 12, 11]);
  assert.deepEqual(seen, [{ scope: WORKTREES, movedId: 12, beforeId: 11 }]);
  assert.deepEqual(entries(), {});
});

test('a rejected worktree move rolls that list back and reports at its row', async () => {
  const client = seededClient();

  const outcome = await commitRailMove({
    intent: { scope: WORKTREES, movedId: 12, beforeId: 11 },
    client,
    move: () => Promise.reject(apiFailure('worktree_order_rejected', 'root_worktree_fixed')),
  });

  assert.equal(outcome, 'failed');
  assert.deepEqual(worktreeIds(client), [10, 11, 12]);
  assert.deepEqual(entries()['worktrees:1'], {
    status: 'failed',
    movedId: 12,
    message: "Couldn't save that order.",
  });
  assert.equal(useToastStore.getState().toasts.length, 0);
});

test('a worktree rejection naming the vanished project toasts instead', async () => {
  const client = seededClient();

  await commitRailMove({
    intent: { scope: WORKTREES, movedId: 12, beforeId: 11 },
    client,
    move: () => Promise.reject(apiFailure('worktree_order_rejected', 'project_not_found')),
  });

  assert.equal(entries()['worktrees:1'], undefined);
  assert.equal(useToastStore.getState().toasts.length, 1);
});

test('a drop that changes nothing makes no request and leaves the query alone', async () => {
  const client = seededClient();
  let calls = 0;

  const outcome = await commitRailMove({
    intent: { scope: SURFACES, movedId: 121, beforeId: 122 },
    client,
    move: () => {
      calls += 1;
      return Promise.resolve({});
    },
  });

  assert.equal(outcome, 'skipped');
  assert.equal(calls, 0);
  assert.deepEqual(entries(), {});
  // No cancel, no invalidation — the drop cost nothing at all.
  assert.notEqual(client.getQueryState(workspaceQueryKey)?.isInvalidated, true);
});

test('a rejected move rolls back only its own list and reports inline', async () => {
  const client = seededClient();

  const outcome = await commitRailMove({
    intent: { scope: SURFACES, movedId: 123, beforeId: 121 },
    client,
    move: () => Promise.reject(apiFailure('surface_order_rejected', 'surface_worktree_mismatch')),
  });

  assert.equal(outcome, 'failed');
  assert.deepEqual(surfaceIds(client), [121, 122, 123]);
  // Unrelated branches are untouched, and the failure waits at the list.
  assert.deepEqual(projectIds(client), [1, 2]);
  assert.deepEqual(entries()['surfaces:12'], {
    status: 'failed',
    movedId: 123,
    message: "Couldn't save that order.",
  });
  assert.equal(useToastStore.getState().toasts.length, 0);
  // An accepted-or-not mutation still owes the cache a reconciliation.
  assert.equal(client.getQueryState(workspaceQueryKey)?.isInvalidated, true);
});

test('a rejection naming the vanished source toasts instead of writing inline', async () => {
  const client = seededClient();

  await commitRailMove({
    intent: { scope: SURFACES, movedId: 123, beforeId: 121 },
    client,
    move: () => Promise.reject(apiFailure('surface_order_rejected', 'surface_not_found')),
  });

  assert.equal(entries()['surfaces:12'], undefined);
  const [toast] = useToastStore.getState().toasts;
  assert.equal(toast?.title, "That surface isn't here anymore.");
  assert.equal(toast?.kind, 'warning');
});

test('an anchor that vanished keeps the failure at the still-present row', async () => {
  const client = seededClient();

  await commitRailMove({
    intent: { scope: SURFACES, movedId: 123, beforeId: 121 },
    client,
    move: () => Promise.reject(apiFailure('surface_order_rejected', 'before_surface_not_found')),
  });

  // The row the user dragged is still on screen, so the message belongs there.
  assert.equal(entries()['surfaces:12']?.status, 'failed');
  assert.equal(useToastStore.getState().toasts.length, 0);

  // ...and it must not claim that row is gone. The disappearance lines all name
  // the dragged thing, but a vanished *anchor* leaves it visible, so this reason
  // reads as the plain code summary — the same line a trust-boundary refusal
  // produces. Compared against that rather than a literal, so rewording the copy
  // does not churn the test.
  const anchorGone = failureMessage('surfaces:12');
  await commitRailMove({
    intent: { scope: SURFACES, movedId: 123, beforeId: 121 },
    client,
    move: () => Promise.reject(apiFailure('surface_order_rejected', 'surface_worktree_mismatch')),
  });
  assert.equal(anchorGone, failureMessage('surfaces:12'));
});

test('a transport failure falls back to the cache to place its message', async () => {
  const client = seededClient();

  await commitRailMove({
    intent: { scope: SURFACES, movedId: 123, beforeId: 121 },
    client,
    move: () => Promise.reject(transportFailure()),
  });

  assert.deepEqual(entries()['surfaces:12'], {
    status: 'failed',
    movedId: 123,
    message: "Couldn't reach the runtime. Is it still running?",
  });
});

test('a move whose whole list disappeared mid-write toasts', async () => {
  const client = seededClient();

  await commitRailMove({
    intent: { scope: SURFACES, movedId: 123, beforeId: 121 },
    client,
    move: () => {
      // The owning worktree is deleted by an unrelated event while we wait.
      client.setQueryData<WorkspaceData>(
        workspaceQueryKey,
        workspace([project({ id: 2, name: 'atlas' })]),
      );
      return Promise.reject(transportFailure());
    },
  });

  assert.equal(entries()['surfaces:12'], undefined);
  assert.equal(useToastStore.getState().toasts.length, 1);
});

test('a second drop in the same list is refused while the first is in flight', async () => {
  const client = seededClient();
  const first = deferredMove();

  const running = commitRailMove({
    intent: { scope: SURFACES, movedId: 123, beforeId: 121 },
    client,
    move: first.move,
  });
  await first.started;
  assert.equal(entries()['surfaces:12']?.status, 'pending');

  const refused = await commitRailMove({
    intent: { scope: SURFACES, movedId: 122, beforeId: null },
    client,
    move: () => Promise.reject(new Error('must not run')),
  });

  assert.equal(refused, 'blocked');
  // The refused intent left no trace on the optimistic order.
  assert.deepEqual(surfaceIds(client), [123, 121, 122]);
  first.settle({ ok: true });
  assert.equal(await running, 'committed');
});

test('independent scopes run concurrently and only the last to settle refreshes', async () => {
  const client = seededClient();
  const surfaces = deferredMove();
  const projects = deferredMove();

  const surfaceRun = commitRailMove({
    intent: { scope: SURFACES, movedId: 123, beforeId: 121 },
    client,
    move: surfaces.move,
  });
  await surfaces.started;
  const projectRun = commitRailMove({
    intent: { scope: PROJECTS, movedId: 2, beforeId: 1 },
    client,
    move: projects.move,
  });
  await projects.started;

  // Both optimistic projections coexist in the one shared snapshot.
  assert.deepEqual(surfaceIds(client), [123, 121, 122]);
  assert.deepEqual(projectIds(client), [2, 1]);

  surfaces.settle({ ok: true });
  assert.equal(await surfaceRun, 'committed');
  // The project write is still pending, so nothing has fetched the snapshot away.
  assert.notEqual(client.getQueryState(workspaceQueryKey)?.isInvalidated, true);
  assert.deepEqual(projectIds(client), [2, 1]);

  projects.settle({ ok: true });
  assert.equal(await projectRun, 'committed');
  assert.equal(client.getQueryState(workspaceQueryKey)?.isInvalidated, true);
});

test('one scope failing does not disturb another scope in flight', async () => {
  const client = seededClient();
  const surfaces = deferredMove();
  const projects = deferredMove();

  const surfaceRun = commitRailMove({
    intent: { scope: SURFACES, movedId: 123, beforeId: 121 },
    client,
    move: surfaces.move,
  });
  await surfaces.started;
  const projectRun = commitRailMove({
    intent: { scope: PROJECTS, movedId: 2, beforeId: 1 },
    client,
    move: projects.move,
  });
  await projects.started;

  surfaces.settle({
    ok: false,
    error: apiFailure('surface_order_rejected', 'before_surface_not_found'),
  });
  assert.equal(await surfaceRun, 'failed');

  // Only the surface list was restored; the project reorder survives untouched.
  assert.deepEqual(surfaceIds(client), [121, 122, 123]);
  assert.deepEqual(projectIds(client), [2, 1]);

  projects.settle({ ok: true });
  assert.equal(await projectRun, 'committed');
  assert.deepEqual(projectIds(client), [2, 1]);
});

test('a reorder never touches selection or workspace store state', async () => {
  const client = seededClient();
  const before = useWorkspaceStore.getState().selection;

  await commitRailMove({
    intent: { scope: SURFACES, movedId: 123, beforeId: 121 },
    client,
    move: () => Promise.resolve({}),
  });
  await commitRailMove({
    intent: { scope: PROJECTS, movedId: 2, beforeId: 1 },
    client,
    move: () => Promise.reject(apiFailure('project_order_rejected', 'before_project_not_found')),
  });

  assert.equal(useWorkspaceStore.getState().selection, before);
});

test('a new drop in a failed scope clears the stale refusal', async () => {
  const client = seededClient();

  await commitRailMove({
    intent: { scope: SURFACES, movedId: 123, beforeId: 121 },
    client,
    move: () => Promise.reject(apiFailure('surface_order_rejected', 'before_surface_not_found')),
  });
  assert.equal(entries()['surfaces:12']?.status, 'failed');

  await commitRailMove({
    intent: { scope: SURFACES, movedId: 122, beforeId: 121 },
    client,
    move: () => Promise.resolve({}),
  });

  assert.equal(entries()['surfaces:12'], undefined);
});

test('an accepted move survives a failing refresh', async () => {
  const client = new QueryClient();
  client.setQueryData(workspaceQueryKey, seed());
  client.invalidateQueries = () => Promise.reject(new Error('refresh failed'));

  const outcome = await commitRailMove({
    intent: { scope: SURFACES, movedId: 123, beforeId: 121 },
    client,
    move: () => Promise.resolve({}),
  });

  // The runtime accepted the move, so the optimistic order stands, no failure
  // was recorded, and the drop site is never told the drag failed — only the
  // follow-up refresh went wrong, which the query layer owns.
  assert.equal(outcome, 'committed');
  assert.deepEqual(surfaceIds(client), [123, 121, 122]);
  assert.deepEqual(entries(), {});
});
