import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { Effect, Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';

import type { ApiError, WorkspaceSnapshot } from '@isagi/contracts';
import { RuntimeApiError, RuntimeTransportError } from '@isagi/runtime-client';

import { runApp } from '../../state/runtime.js';
import { flush, makeTestRegistry } from '../../state/testing.js';
import { toastsAtom } from '../../toast/store.js';
import type { WorkspaceData } from '../model.js';
import { patchWorkspaceData, workspaceAtom } from '../queries.js';
import { commitRailMove, type PersistRailMove } from '../rail-order-commit.js';
import { railOrderAtom } from '../rail-order-state.js';
import { applyRailMove, type RailMoveIntent, type RailOrderScope } from '../rail-order.js';
import { selectionAtom } from '../store.js';
import { project, refuse, snapshotOf, surface, workspace, worktree } from './test-support.js';

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

/**
 * A test app session in front of a fake runtime that owns the durable order.
 *
 * Every workspace read snapshots the runtime's state when it *starts*, as a real request does, and
 * answers at once unless reads are gated (`gateReads`), in which case the test releases each one
 * by hand. Accepted moves change that state, so the convergence read sees them. The workspace is
 * held (mounted) the way the rail holds it.
 */
async function railSession(t: TestContext) {
  let state = seed();
  let reads = 0;
  let gated = false;
  let failReads = false;
  const waiting: Array<() => void> = [];
  const registry = makeTestRegistry({
    retry: false,
    api: {
      fetchWorkspace: () =>
        Effect.suspend(() => {
          reads += 1;
          if (failReads) return refuse('workspace read failed');
          const snapshot = snapshotOf(state);
          if (!gated) return Effect.succeed(snapshot);
          return Effect.callback<WorkspaceSnapshot>((resume) => {
            waiting.push(() => resume(Effect.succeed(snapshot)));
          });
        }),
    },
  });
  t.after(() => registry.dispose());
  t.after(registry.mount(workspaceAtom));
  await flush();

  const shown = () => Option.getOrUndefined(AsyncResult.value(registry.get(workspaceAtom)));
  const runtime = {
    /** The runtime accepts a move: its durable order changes. */
    apply: (intent: RailMoveIntent) => {
      state = applyRailMove(state, intent);
    },
    replace: (data: WorkspaceData) => {
      state = data;
    },
  };

  return {
    registry,
    runtime,
    reads: () => reads,
    commit: (intent: RailMoveIntent, persist: PersistRailMove) =>
      runApp(registry, commitRailMove(intent, persist)),
    /** A runtime that persists every move it is asked for. */
    accept: ((intent) => Effect.sync(() => runtime.apply(intent))) satisfies PersistRailMove,
    gateReads: (on: boolean) => {
      gated = on;
    },
    failReads: () => {
      failReads = true;
    },
    /** Answer the oldest gated read with the state it captured when it started. */
    releaseRead: async () => {
      const release = waiting.shift();
      assert.ok(release, 'a workspace read is waiting');
      release();
      await flush();
    },
    entries: () => registry.get(railOrderAtom).entries,
    surfaceIds: () => {
      // Searched rather than indexed: a project reorder moves the owning project.
      for (const candidate of shown()?.projects ?? []) {
        const found = candidate.worktrees.find((entry) => entry.id === 12);
        if (found) return found.surfaces.map((entry) => entry.id);
      }
      return [];
    },
    worktreeIds: () =>
      shown()
        ?.projects.find((candidate) => candidate.id === 1)
        ?.worktrees.map((entry) => entry.id) ?? [],
    projectIds: () => shown()?.projects.map((candidate) => candidate.id) ?? [],
  };
}

type RailSession = Awaited<ReturnType<typeof railSession>>;

/** The inline refusal text at `scopeKey`, or `null` when the scope is not failed. */
function failureMessage(session: RailSession, scopeKey: string) {
  const entry = session.entries()[scopeKey];
  return entry?.status === 'failed' ? entry.message : null;
}

function apiFailure(code: string, reason: string): RuntimeApiError<ApiError> {
  return new RuntimeApiError({
    endpointId: 'projects.moveOrder',
    apiError: {
      code,
      status: 400,
      message: 'diagnostic',
      requestId: 'req-1',
      data: { reason },
    } as ApiError,
  });
}

function transportFailure() {
  return new RuntimeTransportError({
    endpointId: 'projects.moveOrder',
    cause: new Error('offline'),
  });
}

const refusing =
  (error: Error): PersistRailMove =>
  () =>
    Effect.fail(error);

/**
 * A move whose persistence the test settles by hand. `started` resolves once the commit has
 * actually reached the network step, which is what makes the two-scope overlap deterministic
 * instead of timer-raced. An accepted settlement changes the runtime's order first, as the real
 * runtime commits before it answers.
 */
function deferredMove(session: RailSession) {
  let settleMove: (outcome: { readonly ok: boolean; readonly error?: Error }) => void = () => {
    throw new Error('the move has not started');
  };
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const persist: PersistRailMove = (intent) =>
    Effect.callback<unknown, Error>((resume) => {
      settleMove = (outcome) => {
        if (outcome.ok) {
          session.runtime.apply(intent);
          resume(Effect.succeed({}));
        } else {
          resume(Effect.fail(outcome.error ?? new Error('refused')));
        }
      };
      signalStarted();
    });
  return {
    persist,
    started,
    settle: (outcome: { readonly ok: boolean; readonly error?: Error }) => settleMove(outcome),
  };
}

test('a surface move projects optimistically, persists, and refreshes', async (t) => {
  const session = await railSession(t);
  const seen: RailMoveIntent[] = [];
  const readsBefore = session.reads();

  const outcome = await session.commit({ scope: SURFACES, movedId: 123, beforeId: 121 }, (intent) =>
    Effect.sync(() => {
      // The rail already shows the new order while the write is in flight.
      assert.deepEqual(session.surfaceIds(), [123, 121, 122]);
      seen.push(intent);
      session.runtime.apply(intent);
    }),
  );

  assert.equal(outcome, 'committed');
  assert.deepEqual(session.surfaceIds(), [123, 121, 122]);
  assert.equal(seen.length, 1);
  // Nothing lingers in the reorder state, and exactly one read converged with the runtime.
  assert.deepEqual(session.entries(), {});
  assert.equal(session.reads(), readsBefore + 1);
  assert.deepEqual(
    session.registry.get(railOrderAtom).accepted,
    [],
    'the accepted move retires once a read that began after it lands',
  );
});

test('a project move stays inside the present section', async (t) => {
  const session = await railSession(t);
  const outcome = await session.commit(
    { scope: PROJECTS, movedId: 2, beforeId: 1 },
    session.accept,
  );

  assert.equal(outcome, 'committed');
  assert.deepEqual(session.projectIds(), [2, 1]);
});

test('a worktree move keeps the root pinned above the reordered siblings', async (t) => {
  const session = await railSession(t);
  const seen: RailMoveIntent[] = [];

  const outcome = await session.commit({ scope: WORKTREES, movedId: 12, beforeId: 11 }, (intent) =>
    Effect.sync(() => {
      seen.push(intent);
      session.runtime.apply(intent);
    }),
  );

  assert.equal(outcome, 'committed');
  assert.deepEqual(session.worktreeIds(), [10, 12, 11]);
  assert.deepEqual(seen, [{ scope: WORKTREES, movedId: 12, beforeId: 11 }]);
  assert.deepEqual(session.entries(), {});
});

test('a rejected worktree move rolls that list back and reports at its row', async (t) => {
  const session = await railSession(t);

  const outcome = await session.commit(
    { scope: WORKTREES, movedId: 12, beforeId: 11 },
    refusing(apiFailure('worktree_order_rejected', 'root_worktree_fixed')),
  );

  assert.equal(outcome, 'failed');
  assert.deepEqual(session.worktreeIds(), [10, 11, 12]);
  assert.deepEqual(session.entries()['worktrees:1'], {
    status: 'failed',
    movedId: 12,
    message: "Couldn't save that order.",
  });
  assert.equal(session.registry.get(toastsAtom).length, 0);
});

test('a worktree rejection naming the vanished project toasts instead', async (t) => {
  const session = await railSession(t);

  await session.commit(
    { scope: WORKTREES, movedId: 12, beforeId: 11 },
    refusing(apiFailure('worktree_order_rejected', 'project_not_found')),
  );

  assert.equal(session.entries()['worktrees:1'], undefined);
  assert.equal(session.registry.get(toastsAtom).length, 1);
});

test('a drop that changes nothing makes no request and leaves the query alone', async (t) => {
  const session = await railSession(t);
  const readsBefore = session.reads();
  let calls = 0;

  const outcome = await session.commit({ scope: SURFACES, movedId: 121, beforeId: 122 }, () =>
    Effect.sync(() => {
      calls += 1;
    }),
  );

  assert.equal(outcome, 'skipped');
  assert.equal(calls, 0);
  assert.deepEqual(session.entries(), {});
  // No convergence read either — the drop cost nothing at all.
  assert.equal(session.reads(), readsBefore);
});

test('a rejected move rolls back only its own list and reports inline', async (t) => {
  const session = await railSession(t);
  const readsBefore = session.reads();

  const outcome = await session.commit(
    { scope: SURFACES, movedId: 123, beforeId: 121 },
    refusing(apiFailure('surface_order_rejected', 'surface_worktree_mismatch')),
  );

  assert.equal(outcome, 'failed');
  assert.deepEqual(session.surfaceIds(), [121, 122, 123]);
  // Unrelated branches are untouched, and the failure waits at the list.
  assert.deepEqual(session.projectIds(), [1, 2]);
  assert.deepEqual(session.entries()['surfaces:12'], {
    status: 'failed',
    movedId: 123,
    message: "Couldn't save that order.",
  });
  assert.equal(session.registry.get(toastsAtom).length, 0);
  // An accepted-or-not mutation still owes the workspace a reconciliation.
  assert.equal(session.reads(), readsBefore + 1);
});

test('a rejection naming the vanished source toasts instead of writing inline', async (t) => {
  const session = await railSession(t);

  await session.commit(
    { scope: SURFACES, movedId: 123, beforeId: 121 },
    refusing(apiFailure('surface_order_rejected', 'surface_not_found')),
  );

  assert.equal(session.entries()['surfaces:12'], undefined);
  const [toast] = session.registry.get(toastsAtom);
  assert.equal(toast?.title, "That surface isn't here anymore.");
  assert.equal(toast?.kind, 'warning');
});

test('an anchor that vanished keeps the failure at the still-present row', async (t) => {
  const session = await railSession(t);

  await session.commit(
    { scope: SURFACES, movedId: 123, beforeId: 121 },
    refusing(apiFailure('surface_order_rejected', 'before_surface_not_found')),
  );

  // The row the user dragged is still on screen, so the message belongs there.
  assert.equal(session.entries()['surfaces:12']?.status, 'failed');
  assert.equal(session.registry.get(toastsAtom).length, 0);

  // ...and it must not claim that row is gone. The disappearance lines all name
  // the dragged thing, but a vanished *anchor* leaves it visible, so this reason
  // reads as the plain code summary — the same line a trust-boundary refusal
  // produces. Compared against that rather than a literal, so rewording the copy
  // does not churn the test.
  const anchorGone = failureMessage(session, 'surfaces:12');
  await session.commit(
    { scope: SURFACES, movedId: 123, beforeId: 121 },
    refusing(apiFailure('surface_order_rejected', 'surface_worktree_mismatch')),
  );
  assert.equal(anchorGone, failureMessage(session, 'surfaces:12'));
});

test('a transport failure falls back to the cache to place its message', async (t) => {
  const session = await railSession(t);

  await session.commit(
    { scope: SURFACES, movedId: 123, beforeId: 121 },
    refusing(transportFailure()),
  );

  assert.deepEqual(session.entries()['surfaces:12'], {
    status: 'failed',
    movedId: 123,
    message: "Couldn't reach the runtime. Is it still running?",
  });
});

test('a move whose whole list disappeared mid-write toasts', async (t) => {
  const session = await railSession(t);
  const remaining = workspace([project({ id: 2, name: 'atlas' })]);

  await session.commit({ scope: SURFACES, movedId: 123, beforeId: 121 }, () =>
    Effect.suspend(() => {
      // The owning worktree is deleted by an unrelated event while we wait.
      session.runtime.replace(remaining);
      patchWorkspaceData(session.registry, () => remaining);
      return Effect.fail(transportFailure());
    }),
  );

  assert.equal(session.entries()['surfaces:12'], undefined);
  assert.equal(session.registry.get(toastsAtom).length, 1);
});

test('a second drop in the same list is refused while the first is in flight', async (t) => {
  const session = await railSession(t);
  const first = deferredMove(session);

  const running = session.commit({ scope: SURFACES, movedId: 123, beforeId: 121 }, first.persist);
  await first.started;
  assert.equal(session.entries()['surfaces:12']?.status, 'pending');

  const refused = await session.commit(
    { scope: SURFACES, movedId: 122, beforeId: null },
    refusing(new Error('must not run')),
  );

  assert.equal(refused, 'blocked');
  // The refused intent left no trace on the optimistic order.
  assert.deepEqual(session.surfaceIds(), [123, 121, 122]);
  first.settle({ ok: true });
  assert.equal(await running, 'committed');
});

test('same-tick double drop is blocked', async (t) => {
  const session = await railSession(t);
  const first = deferredMove(session);
  let secondWrites = 0;

  // Both drops start before either has run a single step: only the synchronous claim decides.
  const results = Promise.all([
    session.commit({ scope: PROJECTS, movedId: 2, beforeId: 1 }, first.persist),
    session.commit({ scope: PROJECTS, movedId: 1, beforeId: null }, () =>
      Effect.sync(() => {
        secondWrites += 1;
      }),
    ),
  ]);
  await first.started;
  await flush();

  assert.equal(secondWrites, 0, 'the second drop never reached the runtime');
  first.settle({ ok: true });
  assert.deepEqual(await results, ['committed', 'blocked']);
  assert.deepEqual(session.projectIds(), [2, 1]);
});

test('independent scopes run concurrently and only the last to settle refreshes', async (t) => {
  const session = await railSession(t);
  const surfaces = deferredMove(session);
  const projects = deferredMove(session);

  const surfaceRun = session.commit(
    { scope: SURFACES, movedId: 123, beforeId: 121 },
    surfaces.persist,
  );
  await surfaces.started;
  const projectRun = session.commit({ scope: PROJECTS, movedId: 2, beforeId: 1 }, projects.persist);
  await projects.started;

  // Both optimistic projections coexist over the one shared read.
  assert.deepEqual(session.surfaceIds(), [123, 121, 122]);
  assert.deepEqual(session.projectIds(), [2, 1]);
  const readsBefore = session.reads();

  surfaces.settle({ ok: true });
  assert.equal(await surfaceRun, 'committed');
  // The project write is still pending, so nothing has read the workspace yet.
  assert.equal(session.reads(), readsBefore);
  assert.deepEqual(session.projectIds(), [2, 1]);

  projects.settle({ ok: true });
  assert.equal(await projectRun, 'committed');
  assert.equal(session.reads(), readsBefore + 1);
});

test('one scope failing does not disturb another scope in flight', async (t) => {
  const session = await railSession(t);
  const surfaces = deferredMove(session);
  const projects = deferredMove(session);

  const surfaceRun = session.commit(
    { scope: SURFACES, movedId: 123, beforeId: 121 },
    surfaces.persist,
  );
  await surfaces.started;
  const projectRun = session.commit({ scope: PROJECTS, movedId: 2, beforeId: 1 }, projects.persist);
  await projects.started;

  surfaces.settle({
    ok: false,
    error: apiFailure('surface_order_rejected', 'before_surface_not_found'),
  });
  assert.equal(await surfaceRun, 'failed');

  // Only the surface list was restored; the project reorder survives untouched.
  assert.deepEqual(session.surfaceIds(), [121, 122, 123]);
  assert.deepEqual(session.projectIds(), [2, 1]);

  projects.settle({ ok: true });
  assert.equal(await projectRun, 'committed');
  assert.deepEqual(session.projectIds(), [2, 1]);
});

test('a read that began before an acceptance cannot undo it while another scope is pending', async (t) => {
  const session = await railSession(t);
  const projects = deferredMove(session);
  const surfaces = deferredMove(session);

  const projectRun = session.commit({ scope: PROJECTS, movedId: 2, beforeId: 1 }, projects.persist);
  await projects.started;
  const surfaceRun = session.commit(
    { scope: SURFACES, movedId: 123, beforeId: 121 },
    surfaces.persist,
  );
  await surfaces.started;

  // A runtime event starts a read BEFORE the project write is accepted ...
  session.gateReads(true);
  session.registry.refresh(workspaceAtom);
  await flush();
  const readsBefore = session.reads();

  projects.settle({ ok: true });
  assert.equal(await projectRun, 'committed');
  assert.equal(
    session.reads(),
    readsBefore,
    'no convergence read while the surface move is pending',
  );

  // ... and lands AFTER it, carrying the pre-move project order.
  await session.releaseRead();
  assert.deepEqual(
    session.projectIds(),
    [2, 1],
    'the accepted move is replayed over the stale read',
  );
  assert.deepEqual(session.surfaceIds(), [123, 121, 122], 'the pending move still shows');

  session.gateReads(false);
  surfaces.settle({ ok: true });
  assert.equal(await surfaceRun, 'committed');
  assert.equal(session.reads(), readsBefore + 1, 'the last settlement reads once');
  assert.deepEqual(session.projectIds(), [2, 1]);
  assert.deepEqual(session.surfaceIds(), [123, 121, 122]);
  assert.deepEqual(session.registry.get(railOrderAtom).accepted, []);
});

test('a read already in flight when the drop lands cannot revert it', async (t) => {
  const session = await railSession(t);
  // A focus revalidation is already on the wire, carrying the old order.
  session.gateReads(true);
  session.registry.refresh(workspaceAtom);
  await flush();
  const moves = deferredMove(session);

  const running = session.commit({ scope: PROJECTS, movedId: 2, beforeId: 1 }, moves.persist);
  await moves.started;
  assert.deepEqual(session.projectIds(), [2, 1], 'optimistic');

  await session.releaseRead();
  assert.deepEqual(session.projectIds(), [2, 1], 'the older read is shown under the pending move');

  session.gateReads(false);
  moves.settle({ ok: true });
  assert.equal(await running, 'committed');
  assert.deepEqual(session.projectIds(), [2, 1]);
});

test('no flicker between acceptance and convergence', async (t) => {
  const session = await railSession(t);
  const moves = deferredMove(session);

  const running = session.commit({ scope: PROJECTS, movedId: 2, beforeId: 1 }, moves.persist);
  await moves.started;
  session.gateReads(true);
  const readsBefore = session.reads();

  moves.settle({ ok: true });
  await flush();
  // The convergence read is on the wire; the held read predates the acceptance.
  assert.equal(session.reads(), readsBefore + 1, 'exactly one convergence read');
  assert.deepEqual(session.projectIds(), [2, 1], 'no flicker back while it runs');
  assert.equal(session.registry.get(railOrderAtom).accepted.length, 1);

  await session.releaseRead();
  assert.equal(await running, 'committed');
  assert.deepEqual(session.projectIds(), [2, 1]);
  assert.deepEqual(session.registry.get(railOrderAtom).accepted, []);
});

test('a reorder never touches selection or workspace store state', async (t) => {
  const session = await railSession(t);
  const before = session.registry.get(selectionAtom);

  await session.commit({ scope: SURFACES, movedId: 123, beforeId: 121 }, session.accept);
  await session.commit(
    { scope: PROJECTS, movedId: 2, beforeId: 1 },
    refusing(apiFailure('project_order_rejected', 'before_project_not_found')),
  );

  assert.equal(session.registry.get(selectionAtom), before);
});

test('a new drop in a failed scope clears the stale refusal', async (t) => {
  const session = await railSession(t);

  await session.commit(
    { scope: SURFACES, movedId: 123, beforeId: 121 },
    refusing(apiFailure('surface_order_rejected', 'before_surface_not_found')),
  );
  assert.equal(session.entries()['surfaces:12']?.status, 'failed');

  await session.commit({ scope: SURFACES, movedId: 122, beforeId: 121 }, session.accept);

  assert.equal(session.entries()['surfaces:12'], undefined);
});

test('an accepted move survives a failing refresh', async (t) => {
  const session = await railSession(t);

  const outcome = await session.commit({ scope: SURFACES, movedId: 123, beforeId: 121 }, (intent) =>
    Effect.sync(() => {
      session.runtime.apply(intent);
      session.failReads();
    }),
  );

  // The runtime accepted the move, so the optimistic order stands, no failure
  // was recorded, and the drop site is never told the drag failed — only the
  // follow-up refresh went wrong, which the workspace read owns.
  assert.equal(outcome, 'committed');
  assert.deepEqual(session.surfaceIds(), [123, 121, 122]);
  assert.deepEqual(session.entries(), {});
});

test('a commit with no workspace held is skipped without a request', async (t) => {
  const registry = makeTestRegistry({ retry: false });
  t.after(() => registry.dispose());
  let calls = 0;

  const outcome = await runApp(
    registry,
    commitRailMove({ scope: PROJECTS, movedId: 2, beforeId: 1 }, () =>
      Effect.sync(() => {
        calls += 1;
      }),
    ),
  );

  assert.equal(outcome, 'skipped');
  assert.equal(calls, 0);
});
