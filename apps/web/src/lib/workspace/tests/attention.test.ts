import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateAttention, applyAttentionToProjects, useAttentionStore } from '../attention.js';
import type { Project } from '../types.js';
import { surfaceLockState, workflowSurfaceAttention } from '../workflow-derive.js';

test('attention aggregation prioritizes error, then working, then waiting, then idle', () => {
  assert.equal(aggregateAttention(['waiting', 'idle']), 'waiting');
  assert.equal(aggregateAttention(['waiting', 'working']), 'working');
  assert.equal(aggregateAttention(['working', 'error']), 'error');
});

test('attention snapshots replace source state and derive surface and worktree rollups', () => {
  useAttentionStore.getState().replaceSources([
    {
      worktreeId: 10,
      surfaceId: 101,
      paneId: 1001,
      source: { kind: 'agent_session', id: 1 },
      attention: 'waiting',
    },
  ]);
  useAttentionStore.getState().replaceSources([
    {
      worktreeId: 10,
      surfaceId: 102,
      paneId: 1002,
      source: { kind: 'terminal_session', id: 2 },
      attention: 'working',
    },
  ]);

  const [project] = applyAttentionToProjects(
    [projectFixture()],
    useAttentionStore.getState().sourcesByKey,
  );
  const worktree = project?.worktrees[0];

  assert.equal(worktree?.attention, 'working');
  assert.equal(worktree?.surfaces[0]?.attention, 'idle');
  assert.equal(worktree?.surfaces[1]?.attention, 'working');
});

test('workflow surface attention overrides pane attention without changing pane aggregation', () => {
  const [project] = applyAttentionToProjects(
    [projectFixture()],
    {
      'agent_session:1': {
        worktreeId: 10,
        surfaceId: 101,
        paneId: 1001,
        source: { kind: 'agent_session', id: 1 },
        attention: 'waiting',
      },
    },
    {
      101: {
        surfaceId: 101,
        rootRunId: 77,
        status: 'driving',
        title: 'Gate',
      },
    },
  );

  assert.equal(project?.worktrees[0]?.surfaces[0]?.attention, 'working');
});

test('workflow derivations map status to lock and attention signals', () => {
  assert.equal(surfaceLockState(undefined), false);
  assert.equal(
    surfaceLockState({ surfaceId: 1, rootRunId: 1, status: 'driving', title: 'Gate' }),
    true,
  );
  assert.equal(
    surfaceLockState({ surfaceId: 1, rootRunId: 1, status: 'waiting_user', title: 'Gate' }),
    false,
  );
  assert.equal(
    workflowSurfaceAttention({ surfaceId: 1, rootRunId: 1, status: 'driving', title: 'Gate' }),
    'working',
  );
  assert.equal(
    workflowSurfaceAttention({
      surfaceId: 1,
      rootRunId: 1,
      status: 'waiting_user',
      title: 'Gate',
    }),
    'waiting',
  );
  assert.equal(
    workflowSurfaceAttention({ surfaceId: 1, rootRunId: 1, status: 'paused', title: 'Gate' }),
    'idle',
  );
  assert.equal(
    workflowSurfaceAttention({ surfaceId: 1, rootRunId: 1, status: 'failed', title: 'Gate' }),
    'error',
  );
  assert.equal(
    workflowSurfaceAttention({ surfaceId: 1, rootRunId: 1, status: 'done', title: 'Gate' }),
    null,
  );
});

function projectFixture(): Project {
  return {
    id: 1,
    name: 'isagi',
    rootPath: '/repo/isagi',
    status: 'present',
    glyph: 'I',
    accent: 'blue',
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
        attention: 'idle',
        surfaces: [
          { id: 101, title: 'Pi', paneKinds: ['agent_session'], attention: 'idle' },
          { id: 102, title: 'Terminal', paneKinds: ['terminal_session'], attention: 'idle' },
        ],
        activeSurfaceId: null,
      },
    ],
  };
}
