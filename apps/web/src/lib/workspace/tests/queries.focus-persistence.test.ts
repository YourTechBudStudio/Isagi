import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { Effect, Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';

import type { SetWorktreeEnvironmentFocusInput, SurfaceDetail } from '@isagi/contracts';

import { peek } from '../../state/policy.js';
import { runApp } from '../../state/runtime.js';
import { controllable, flush } from '../../state/testing.js';
import { activateSurface } from '../activation.js';
import { commitDeleteSurfaceSuccess } from '../commits.js';
import type { WorkspaceData } from '../model.js';
import { cachedWorkspaceData, surfaceDetailAtom } from '../queries.js';
import { activeSurfaceByWorktreeAtom } from '../store.js';
import { holdWorkspace, project, workspaceSession } from './test-support.js';

const existing: WorkspaceData = {
  projects: [
    project({
      id: 1,
      name: 'existing',
      surfaces: [
        { id: 101, title: 'Pi', paneKinds: ['agent_session'], attention: 'idle' },
        { id: 102, title: 'Terminal', paneKinds: ['terminal_session'], attention: 'idle' },
      ],
    }),
  ],
};

const fresh: WorkspaceData = {
  projects: [
    project({
      id: 1,
      name: 'fresh',
      surfaces: [
        { id: 102, title: 'Terminal', paneKinds: ['terminal_session'], attention: 'idle' },
      ],
    }),
  ],
};

/** A session holding `existing` and both surfaces' detail; focus writes wait for the test. */
async function focusSession(t: TestContext) {
  const focusWrites = controllable<{ readonly worktreeId: number }>();
  const requests: Array<SetWorktreeEnvironmentFocusInput> = [];
  const session = workspaceSession(t, [existing, fresh], {
    api: {
      getSurfaceDetail: (surfaceId) =>
        Effect.succeed(surfaceDetail(surfaceId, surfaceId + 100) as unknown as SurfaceDetail),
      setWorktreeEnvironmentFocus: (_worktreeId, input) =>
        Effect.suspend(() => {
          requests.push(input);
          return focusWrites.effect;
        }) as never,
    },
  });
  await holdWorkspace(t, session.registry);
  t.after(session.registry.mount(surfaceDetailAtom(101)));
  t.after(session.registry.mount(surfaceDetailAtom(102)));
  await flush();
  return { ...session, focusWrites, requests };
}

test('surface focus persistence ignores stale success responses', async (t) => {
  const { registry, focusWrites, requests } = await focusSession(t);

  activateSurface(registry, { worktreeId: 10, surfaceId: 101 });
  activateSurface(registry, { worktreeId: 10, surfaceId: 102 });
  await flush();
  assert.equal(requests.length, 2);

  focusWrites.calls[1]!.resolve({ worktreeId: 10 });
  await flush();
  assert.equal(activeSurfaceId(registry), 102);

  focusWrites.calls[0]!.resolve({ worktreeId: 10 });
  await flush();
  assert.equal(activeSurfaceId(registry), 102);
  assert.equal(
    Option.getOrUndefined(Option.flatMap(peek(registry, surfaceDetailAtom(102)), AsyncResult.value))
      ?.activePaneId,
    202,
  );
});

test('surface delete prevents stale focus persistence from restoring deleted surface', async (t) => {
  const { registry, focusWrites, requests } = await focusSession(t);
  registry.set(activeSurfaceByWorktreeAtom, { 10: 101 });

  activateSurface(registry, { worktreeId: 10, surfaceId: 101 });
  await flush();
  assert.equal(requests.length, 1);

  await runApp(
    registry,
    commitDeleteSurfaceSuccess({
      worktreeId: 10,
      surfaceId: 101,
      output: { deletedSurfaceId: 101, deletedPaneIds: [201] },
      successorSurfaceId: null,
    }),
  );

  assert.notEqual(activeSurfaceId(registry), 101);
  focusWrites.calls[0]!.resolve({ worktreeId: 10 });
  await flush();
  assert.notEqual(activeSurfaceId(registry), 101);
  assert.deepEqual(registry.get(activeSurfaceByWorktreeAtom), {});
});

function activeSurfaceId(registry: Parameters<typeof cachedWorkspaceData>[0]) {
  return cachedWorkspaceData(registry)?.projects[0]?.worktrees[0]?.activeSurfaceId;
}

function surfaceDetail(surfaceId: number, paneId: number) {
  return {
    id: surfaceId,
    worktreeId: 10,
    title: 'Terminal',
    attention: 'idle',
    layout: { kind: 'leaf', nodeId: `pane-${paneId}`, paneId, collapsed: false },
    activePaneId: paneId,
    panes: [
      {
        id: paneId,
        surfaceId,
        title: 'Pane',
        attention: 'idle',
        sortOrder: 0,
        session: null,
      },
    ],
  };
}
