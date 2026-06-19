import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateAttention, applyAttentionToProjects, useAttentionStore } from './attention.js';
import type { Project } from './types.js';

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
          { id: 101, kind: 'agent', title: 'Pi', attention: 'idle' },
          { id: 102, kind: 'terminal', title: 'Terminal', attention: 'idle' },
        ],
        activeSurfaceId: null,
      },
    ],
  };
}
