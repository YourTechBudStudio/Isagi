import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';

import type { CreateSurfaceOutput, SurfaceDetail } from '@isagi/contracts';

import { peek } from '../../state/policy.js';
import { runApp } from '../../state/runtime.js';
import { flush } from '../../state/testing.js';
import {
  commitAddProjectSuccess,
  commitDeletePaneSuccess,
  commitDeleteSurfaceSuccess,
  commitDeleteWorktreeSuccess,
  commitLaunchSessionSuccess,
  commitOpenWorktreeSuccess,
  deleteSurfaceFromPalette,
  startAgentSessionFromPalette,
} from '../commits.js';
import type { WorkspaceData } from '../model.js';
import { cachedWorkspaceData, surfaceDetailAtom } from '../queries.js';
import {
  activePaneBySurfaceAtom,
  activeSurfaceByWorktreeAtom,
  emptyWorkspaceSelection,
  forgetSurface,
  selectionAtom,
  setSelection,
} from '../store.js';
import {
  heldProjectIds,
  holdWorkspace,
  project,
  refuse,
  snapshotOf,
  workspaceSession,
} from './test-support.js';

/** A `fetchWorkspace` that answers `first` and then whatever `next()` says when the read runs. */
const sequence = (first: WorkspaceData, next: () => WorkspaceData) => {
  let reads = 0;
  return () => Effect.sync(() => snapshotOf(reads++ === 0 ? first : next()));
};

test('open-worktree success refetches workspace before selecting returned worktree', async (t) => {
  const events: string[] = [];
  const { registry } = workspaceSession(t, [], {
    api: {
      fetchWorkspace: sequence({ projects: [project({ id: 1, name: 'stale-but-fresh' })] }, () => {
        events.push(`fetch:${registry.get(selectionAtom).kind}`);
        return { projects: [project({ id: 2, name: 'next' })] };
      }),
    },
  });
  await holdWorkspace(t, registry);
  setSelection(registry, emptyWorkspaceSelection);

  await runApp(
    registry,
    commitOpenWorktreeSuccess({
      projectId: 2,
      worktreeId: 22,
      branch: 'feature/new',
      status: 'created',
      setup: { status: 'skipped', reason: 'not_configured' },
    }),
  );

  events.push(`select:${registry.get(selectionAtom).kind}`);
  assert.deepEqual(events, ['fetch:empty', 'select:worktree']);
  assert.deepEqual(registry.get(selectionAtom), {
    kind: 'worktree',
    projectId: 2,
    worktreeId: 22,
  });
  assert.deepEqual(heldProjectIds(registry), [2]);
});

test('add-project success invalidates the workspace query without cache surgery', async (t) => {
  const existing = { projects: [project({ id: 1, name: 'existing' })] };
  const { registry, reads } = workspaceSession(t, [existing]);
  await holdWorkspace(t, registry);

  await runApp(registry, commitAddProjectSuccess({ reconcile: false }));

  // The held workspace was re-read, and its data came from that read, not from local edits.
  assert.equal(reads(), 2);
  assert.deepEqual(heldProjectIds(registry), [1]);
});

test('launch success refetches workspace and selects the new surface locally', async (t) => {
  const events: string[] = [];
  const { registry } = workspaceSession(t, [], {
    api: {
      fetchWorkspace: sequence(
        {
          projects: [
            project({
              id: 1,
              name: 'stale',
              surfaces: [
                { id: 100, title: 'Terminal', paneKinds: ['terminal_session'], attention: 'idle' },
              ],
            }),
          ],
        },
        () => {
          events.push(`fetch:${registry.get(activeSurfaceByWorktreeAtom)[10] ?? 'none'}`);
          return {
            projects: [
              project({
                id: 1,
                name: 'fresh',
                surfaces: [
                  {
                    id: 501,
                    title: 'Terminal 2',
                    paneKinds: ['terminal_session'],
                    attention: 'working',
                  },
                ],
              }),
            ],
          };
        },
      ),
    },
  });
  await holdWorkspace(t, registry);

  // A real session caller still hands over its whole `CreateSurfaceOutput`; the
  // generalized parameter accepts it structurally and reads only the placement.
  const sessionOutput: CreateSurfaceOutput = {
    worktreeId: 10,
    surfaceId: 501,
    paneId: 601,
    title: 'Terminal 2',
  };

  await runApp(registry, commitLaunchSessionSuccess(sessionOutput));

  events.push(`select:${registry.get(activeSurfaceByWorktreeAtom)[10] ?? 'none'}`);
  assert.deepEqual(events, ['fetch:none', 'select:501']);
  assert.equal(registry.get(activePaneBySurfaceAtom)[501], 601);
  assert.equal(cachedWorkspaceData(registry)?.projects[0]?.name, 'fresh');
});

test('a bare placement settles and activates, with no title to name the surface', async (t) => {
  // Opening an editor answers with placement only. The commit reads exactly the
  // three fields it always read, so this needs no editor-shaped stand-in.
  const { registry } = workspaceSession(t, [
    { projects: [project({ id: 1, name: 'stale' })] },
    {
      projects: [
        project({
          id: 1,
          name: 'fresh',
          surfaces: [
            { id: 777, title: 'Editor', paneKinds: ['editor_context'], attention: 'idle' },
          ],
        }),
      ],
    },
  ]);
  await holdWorkspace(t, registry);

  await runApp(
    registry,
    commitLaunchSessionSuccess({ worktreeId: 10, surfaceId: 777, paneId: 888 }),
  );

  assert.equal(registry.get(activeSurfaceByWorktreeAtom)[10], 777);
  assert.equal(registry.get(activePaneBySurfaceAtom)[777], 888);
});

test('failed agent launch invalidates workspace so persisted empty surfaces can appear', async (t) => {
  const launchError = 'agent session creation failed';
  const { registry, reads } = workspaceSession(
    t,
    [{ projects: [project({ id: 1, name: 'stale', surfaces: [] })] }],
    { api: { createSurface: () => refuse(launchError) } },
  );
  await holdWorkspace(t, registry);

  await assert.rejects(() => runApp(registry, startAgentSessionFromPalette(10, 'pi')), {
    message: launchError,
  });

  assert.equal(reads(), 2, 'the held workspace was re-read after the failed launch');
});

test('delete surface success refetches workspace and clears only stale local overrides', async (t) => {
  let detailReads = 0;
  const { registry } = workspaceSession(
    t,
    [
      {
        projects: [
          project({
            id: 1,
            name: 'stale',
            surfaces: [
              { id: 501, title: 'Terminal', paneKinds: ['terminal_session'], attention: 'idle' },
            ],
          }),
        ],
      },
      {
        projects: [
          project({
            id: 1,
            name: 'fresh',
            surfaces: [
              { id: 502, title: 'Terminal 2', paneKinds: ['terminal_session'], attention: 'idle' },
            ],
          }),
        ],
      },
    ],
    {
      api: {
        getSurfaceDetail: (surfaceId) =>
          Effect.sync(() => {
            detailReads += 1;
            return { id: surfaceId } as unknown as SurfaceDetail;
          }),
      },
    },
  );
  await holdWorkspace(t, registry);
  t.after(registry.mount(surfaceDetailAtom(501)));
  await flush();
  registry.set(activeSurfaceByWorktreeAtom, { 10: 501, 20: 999 });
  registry.set(activePaneBySurfaceAtom, { 501: 601, 999: 1001 });

  await runApp(
    registry,
    commitDeleteSurfaceSuccess({
      worktreeId: 10,
      surfaceId: 501,
      output: { deletedSurfaceId: 501, deletedPaneIds: [601] },
      successorSurfaceId: null,
    }),
  );
  await flush();

  // The deleted surface's detail is not read again (it stays in the cache, and nothing refreshes
  // it either).
  assert.equal(detailReads, 1);
  assert.deepEqual(registry.get(activeSurfaceByWorktreeAtom), { 20: 999 });
  assert.deepEqual(registry.get(activePaneBySurfaceAtom), { 999: 1001 });
  assert.equal(cachedWorkspaceData(registry)?.projects[0]?.name, 'fresh');
});

test('delete pane success clears only the deleted pane override and keeps the surface', async (t) => {
  let detailReads = 0;
  const { registry } = workspaceSession(
    t,
    [
      {
        projects: [
          project({
            id: 1,
            name: 'fresh',
            surfaces: [
              { id: 501, title: 'Terminal', paneKinds: ['terminal_session'], attention: 'idle' },
            ],
          }),
        ],
      },
    ],
    {
      api: {
        getSurfaceDetail: (surfaceId) =>
          Effect.sync(() => {
            detailReads += 1;
            return { id: surfaceId } as unknown as SurfaceDetail;
          }),
      },
    },
  );
  await holdWorkspace(t, registry);
  t.after(registry.mount(surfaceDetailAtom(501)));
  await flush();
  registry.set(activeSurfaceByWorktreeAtom, { 10: 501 });
  registry.set(activePaneBySurfaceAtom, { 501: 601 });

  await runApp(
    registry,
    commitDeletePaneSuccess({
      worktreeId: 10,
      surfaceId: 501,
      paneId: 601,
      output: { deletedPaneIds: [601] },
    }),
  );

  assert.deepEqual(registry.get(activeSurfaceByWorktreeAtom), { 10: 501 });
  assert.deepEqual(registry.get(activePaneBySurfaceAtom), {});
  // The surface's detail is kept and re-read.
  assert.equal(detailReads, 2);
  assert.deepEqual(
    Option.flatMap(peek(registry, surfaceDetailAtom(501)), AsyncResult.value).pipe(
      Option.getOrUndefined,
    ),
    { id: 501 },
  );
});

test('delete worktree success refetches workspace and selects returned root worktree', async (t) => {
  const events: string[] = [];
  const { registry } = workspaceSession(t, [], {
    api: {
      fetchWorkspace: () =>
        Effect.sync(() => {
          events.push(`fetch:${registry.get(selectionAtom).kind}`);
          return snapshotOf({ projects: [project({ id: 1, name: 'fresh', surfaces: [] })] });
        }),
    },
  });
  setSelection(registry, emptyWorkspaceSelection);

  await runApp(
    registry,
    commitDeleteWorktreeSuccess({
      projectId: 1,
      deletedWorktreeId: 11,
      selectedWorktreeId: 10,
      branchRemoval: { status: 'not_requested' },
    }),
  );

  events.push(`select:${registry.get(selectionAtom).kind}`);
  assert.deepEqual(events, ['fetch:empty', 'select:worktree']);
  assert.deepEqual(registry.get(selectionAtom), {
    kind: 'worktree',
    projectId: 1,
    worktreeId: 10,
  });
});

test('delete worktree success falls back through selection reconciliation when returned root is absent', async (t) => {
  const { registry } = workspaceSession(t, [
    { projects: [project({ id: 1, name: 'fresh', surfaces: [] })] },
  ]);
  setSelection(registry, {
    kind: 'worktree',
    projectId: 1,
    worktreeId: 11,
  });

  await runApp(
    registry,
    commitDeleteWorktreeSuccess({
      projectId: 1,
      deletedWorktreeId: 11,
      selectedWorktreeId: 999,
      branchRemoval: { status: 'not_requested' },
    }),
  );

  assert.deepEqual(registry.get(selectionAtom), {
    kind: 'worktree',
    projectId: 1,
    worktreeId: 10,
  });
});

/** The worktree from the manual test plan: four surfaces, rail order as the runtime returns it. */
const fourSurfaces = (ids: readonly number[]): WorkspaceData => ({
  projects: [
    project({
      id: 1,
      name: 'repo',
      surfaces: ids.map((id) => ({
        id,
        title: ['Terminal', 'Pi', 'Claude', 'Claude 2'][id - 1]!,
        paneKinds: ['agent_session' as const],
        attention: 'idle' as const,
      })),
    }),
  ],
});

/**
 * A session where deleting a surface behaves like the runtime: the `surface_changed` event (which
 * forgets the active override) lands before the HTTP response, and the next read lacks the surface.
 */
async function deleteSurfaceSession(t: Parameters<typeof workspaceSession>[0], deleted: number) {
  const focusWrites: number[] = [];
  const remaining = [1, 2, 3, 4].filter((id) => id !== deleted);
  const { registry } = workspaceSession(t, [fourSurfaces([1, 2, 3, 4]), fourSurfaces(remaining)], {
    api: {
      deleteSurface: (surfaceId) =>
        Effect.sync(() => {
          forgetSurface(registry, 10, surfaceId);
          return { deletedSurfaceId: surfaceId, deletedPaneIds: [surfaceId * 100] };
        }),
      getSurfaceDetail: (surfaceId) =>
        Effect.succeed({
          id: surfaceId,
          worktreeId: 10,
          activePaneId: surfaceId * 100,
          panes: [{ id: surfaceId * 100 }],
        } as unknown as SurfaceDetail),
      setWorktreeEnvironmentFocus: (_worktreeId, input) =>
        Effect.sync(() => {
          focusWrites.push(input.activeSurfaceId ?? 0);
          return { worktreeId: 10 };
        }) as never,
    },
  });
  await holdWorkspace(t, registry);
  return { registry, focusWrites };
}

test('deleting the active surface activates its next neighbour and persists that focus', async (t) => {
  const { registry, focusWrites } = await deleteSurfaceSession(t, 3);
  registry.set(activeSurfaceByWorktreeAtom, { 10: 3 });

  await runApp(registry, deleteSurfaceFromPalette({ worktreeId: 10, surfaceId: 3 }));
  await flush();

  assert.equal(registry.get(activeSurfaceByWorktreeAtom)[10], 4, 'Claude 2 follows Claude');
  assert.equal(registry.get(activePaneBySurfaceAtom)[4], 400);
  assert.deepEqual(focusWrites, [4]);
});

test('deleting the last active surface in the rail activates the previous one', async (t) => {
  const { registry } = await deleteSurfaceSession(t, 4);
  registry.set(activeSurfaceByWorktreeAtom, { 10: 4 });

  await runApp(registry, deleteSurfaceFromPalette({ worktreeId: 10, surfaceId: 4 }));
  await flush();

  assert.equal(registry.get(activeSurfaceByWorktreeAtom)[10], 3);
});

test('deleting a surface that is not active keeps the active surface', async (t) => {
  const { registry, focusWrites } = await deleteSurfaceSession(t, 3);
  registry.set(activeSurfaceByWorktreeAtom, { 10: 1 });

  await runApp(registry, deleteSurfaceFromPalette({ worktreeId: 10, surfaceId: 3 }));
  await flush();

  assert.equal(registry.get(activeSurfaceByWorktreeAtom)[10], 1);
  assert.deepEqual(focusWrites, []);
});
