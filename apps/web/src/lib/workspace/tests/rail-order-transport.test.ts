import assert from 'node:assert/strict';
import test, { afterEach, type TestContext } from 'node:test';

import { Effect, Option } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';

import type { WorkspaceSnapshot } from '@isagi/contracts';

import { RuntimeApi } from '../../runtime/client.js';
import { refreshAndRead } from '../../state/policy.js';
import { runApp, runtimeApiLayerAtom } from '../../state/runtime.js';
import { makeTestRegistry } from '../../state/testing.js';
import { patchWorkspaceData, workspaceAtom, workspaceReadAtom } from '../queries.js';
import { commitRailMove, type PersistRailMove } from '../rail-order-commit.js';
import { railOrderAtom } from '../rail-order-state.js';
import { applyRailMove, moveBefore, type RailMoveIntent } from '../rail-order.js';

/**
 * The rest of the reorder suite injects persistence and a fake runtime API so the workflow can be
 * tested without a network. This file deliberately does not: it drives `commitRailMove` and the
 * workspace read through the production `RuntimeApi` layer over a stubbed `fetch`, so an endpoint,
 * method, anchor field or snapshot decode that drifts fails here rather than looking correct all
 * the way to the runtime's door.
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
      kind: 'git',
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
      kind: 'git',
      status: 'present',
      worktrees: [],
    },
  ],
} satisfies WorkspaceSnapshot;

const WORKSPACE_URL = 'http://runtime.test/api/v1/workspace';

const envelope = (data: unknown, requestId: string) =>
  new Response(JSON.stringify({ data, meta: { requestId } }), { status: 200 });

/** The runtime's durable order after it accepts a move (only the scopes this suite moves). */
function acceptIntoSnapshot(state: WorkspaceSnapshot, intent: RailMoveIntent): WorkspaceSnapshot {
  const { scope } = intent;
  const reorder = <T extends { readonly id: number }>(items: readonly T[]): T[] => {
    const byId = new Map(items.map((item) => [item.id, item]));
    return moveBefore(
      items.map((item) => item.id),
      intent.movedId,
      intent.beforeId,
    ).map((id) => byId.get(id)!);
  };
  switch (scope.kind) {
    case 'projects':
      return { ...state, projects: reorder(state.projects) };
    case 'surfaces':
      return {
        ...state,
        projects: state.projects.map((project) => ({
          ...project,
          worktrees: project.worktrees.map((worktree) =>
            worktree.id === scope.worktreeId
              ? { ...worktree, surfaces: reorder(worktree.surfaces) }
              : worktree,
          ),
        })),
      };
    case 'worktrees':
      throw new Error('this suite does not accept worktree moves into the snapshot');
  }
}

/**
 * A stubbed runtime behind `fetch`. Workspace reads answer with the durable order as it was when
 * the request arrived (optionally held until the test releases it); every other request is
 * recorded and answered by `answer`.
 */
function fakeRuntime(answer: (requestId: string) => Response = () => envelope({}, 'req-write')) {
  let state: WorkspaceSnapshot = snapshot;
  const requests: RecordedRequest[] = [];
  let hold: Promise<void> | null = null;
  let readStarted: () => void = () => {};
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url === WORKSPACE_URL) {
      const answered = state;
      readStarted();
      if (hold !== null) await hold;
      return envelope(answered, 'req-read');
    }
    requests.push({ url, method, body: String(init?.body ?? '') });
    return answer(`req-${requests.length}`);
  }) as typeof fetch;
  return {
    /** Requests other than workspace reads, in order. */
    requests,
    accept: (intent: RailMoveIntent) => {
      state = acceptIntoSnapshot(state, intent);
    },
    /** Hold the next workspace responses until `release`; resolves once a read reaches the runtime. */
    holdReads: () => {
      let release!: () => void;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        readStarted = resolve;
      });
      return {
        started,
        release: () => {
          hold = null;
          readStarted = () => {};
          release();
        },
      };
    },
  };
}

type FakeRuntime = ReturnType<typeof fakeRuntime>;

/** A test app session on the production `RuntimeApi` layer, holding the workspace like the rail. */
async function railSession(t: TestContext) {
  const registry = makeTestRegistry({
    retry: false,
    initialValues: [[runtimeApiLayerAtom, RuntimeApi.layer]],
  });
  t.after(() => registry.dispose());
  t.after(registry.mount(workspaceAtom));
  await runApp(registry, Atom.getResult(workspaceReadAtom, { suspendOnWaiting: true }));
  const shown = () => Option.getOrUndefined(AsyncResult.value(registry.get(workspaceAtom)));
  return {
    registry,
    commit: (intent: RailMoveIntent, persist?: PersistRailMove) =>
      runApp(registry, commitRailMove(intent, persist)),
    /** A workspace read that begins now, awaited until it lands (the old `fetchQuery`). */
    refresh: () => runApp(registry, refreshAndRead(workspaceReadAtom)),
    surfaceIds: () =>
      shown()
        ?.projects.flatMap((project) => project.worktrees)
        .find((worktree) => worktree.id === 12)
        ?.surfaces.map((entry) => entry.id) ?? [],
    projectIds: () => shown()?.projects.map((project) => project.id) ?? [],
  };
}

/**
 * A move the test settles by hand. `started` resolves once the commit has
 * actually reached the network step, which is what makes an overlap
 * deterministic rather than timer-raced. Settling accepts the move into the
 * runtime's order first, as the real runtime commits before it answers.
 */
function deferredMove(runtime: FakeRuntime) {
  let settleMove: () => void = () => {
    throw new Error('the move has not started');
  };
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const persist: PersistRailMove = (intent) =>
    Effect.callback<unknown, Error>((resume) => {
      settleMove = () => {
        runtime.accept(intent);
        resume(Effect.succeed({}));
      };
      signalStarted();
    });
  return { persist, started, settle: () => settleMove() };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('a surface drop reaches the surface order endpoint with its anchor', async (t) => {
  const runtime = fakeRuntime(() => envelope({ worktreeId: 12, surfaceId: 123 }, 'req-write'));
  const session = await railSession(t);

  const outcome = await session.commit({
    scope: { kind: 'surfaces', worktreeId: 12 },
    movedId: 123,
    beforeId: 121,
  });

  assert.equal(outcome, 'committed');
  assert.deepEqual(runtime.requests, [
    {
      url: 'http://runtime.test/api/v1/worktrees/12/surfaces/123/order',
      method: 'PUT',
      body: JSON.stringify({ beforeSurfaceId: 121 }),
    },
  ]);
});

test('a worktree drop names its project in the path and its anchor in the body', async (t) => {
  const runtime = fakeRuntime(() => envelope({ projectId: 1, worktreeId: 13 }, 'req-write'));
  const session = await railSession(t);

  const outcome = await session.commit({
    scope: { kind: 'worktrees', projectId: 1 },
    movedId: 13,
    beforeId: 12,
  });

  assert.equal(outcome, 'committed');
  assert.deepEqual(runtime.requests, [
    {
      url: 'http://runtime.test/api/v1/projects/1/worktrees/13/order',
      method: 'PUT',
      body: JSON.stringify({ beforeWorktreeId: 12 }),
    },
  ]);
});

test('a project drop to the end sends a null anchor', async (t) => {
  const runtime = fakeRuntime(() => envelope({ projectId: 1 }, 'req-write'));
  const session = await railSession(t);

  const outcome = await session.commit({
    scope: { kind: 'projects' },
    movedId: 1,
    beforeId: null,
  });

  assert.equal(outcome, 'committed');
  assert.deepEqual(runtime.requests, [
    {
      url: 'http://runtime.test/api/v1/projects/1/order',
      method: 'PUT',
      body: JSON.stringify({ beforeProjectId: null }),
    },
  ]);
});

test('a runtime refusal over the real transport rolls back and reports inline', async (t) => {
  fakeRuntime(
    () =>
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
  );
  const session = await railSession(t);

  const outcome = await session.commit({
    scope: { kind: 'surfaces', worktreeId: 12 },
    movedId: 123,
    beforeId: 121,
  });

  assert.equal(outcome, 'failed');
  assert.deepEqual(session.surfaceIds(), [121, 122, 123]);
  assert.deepEqual(session.registry.get(railOrderAtom).entries['surfaces:12'], {
    status: 'failed',
    movedId: 123,
    message: "Couldn't save that order.",
  });
});

test('a workspace refresh that lands mid-write keeps the pending order on screen', async (t) => {
  const runtime = fakeRuntime();
  const session = await railSession(t);

  // Settled by hand, so the refresh below is guaranteed to arrive while the
  // write is still outstanding.
  const surfaces = deferredMove(runtime);
  const running = session.commit(
    { scope: { kind: 'surfaces', worktreeId: 12 }, movedId: 123, beforeId: 121 },
    surfaces.persist,
  );
  await surfaces.started;
  assert.deepEqual(session.surfaceIds(), [123, 121, 122]);

  // Something else entirely — a runtime session event, reconciliation finishing —
  // re-reads the shared workspace, and the runtime answers with the pre-move
  // order because the reorder has not been persisted yet.
  await session.refresh();

  assert.deepEqual(session.surfaceIds(), [123, 121, 122]);
  surfaces.settle();
  assert.equal(await running, 'committed');
  assert.deepEqual(session.surfaceIds(), [123, 121, 122]);
});

test('a stale response cannot erase an accepted move while another scope is pending', async (t) => {
  const runtime = fakeRuntime();
  const session = await railSession(t);

  const projects = deferredMove(runtime);
  const surfaces = deferredMove(runtime);
  const projectRun = session.commit(
    { scope: { kind: 'projects' }, movedId: 2, beforeId: 1 },
    projects.persist,
  );
  await projects.started;
  const surfaceRun = session.commit(
    { scope: { kind: 'surfaces', worktreeId: 12 }, movedId: 123, beforeId: 121 },
    surfaces.persist,
  );
  await surfaces.started;
  assert.deepEqual(session.projectIds(), [2, 1]);
  assert.deepEqual(session.surfaceIds(), [123, 121, 122]);

  // An unrelated refresh reads the runtime *before* either move is accepted, so
  // its answer carries the original order for both scopes.
  const held = runtime.holdReads();
  const stale = session.refresh();
  await held.started;

  // The project move is accepted, so it stops being pending — but the surface
  // move is still pending, so this settlement defers the shared refresh.
  projects.settle();
  assert.equal(await projectRun, 'committed');

  held.release();
  await stale;

  // The stale answer must not undo the move the runtime has already accepted.
  assert.deepEqual(session.projectIds(), [2, 1]);
  assert.deepEqual(session.surfaceIds(), [123, 121, 122]);

  surfaces.settle();
  assert.equal(await surfaceRun, 'committed');
  assert.deepEqual(session.projectIds(), [2, 1]);
  assert.deepEqual(session.surfaceIds(), [123, 121, 122]);
});

test('a workspace refresh with nothing pending installs the runtime order verbatim', async (t) => {
  fakeRuntime();
  const session = await railSession(t);
  // A stale local order, left behind on the held read.
  patchWorkspaceData(session.registry, (data) =>
    applyRailMove(data, {
      scope: { kind: 'surfaces', worktreeId: 12 },
      movedId: 123,
      beforeId: 121,
    }),
  );
  assert.deepEqual(session.surfaceIds(), [123, 121, 122]);

  await session.refresh();

  assert.deepEqual(session.surfaceIds(), [121, 122, 123]);
});
