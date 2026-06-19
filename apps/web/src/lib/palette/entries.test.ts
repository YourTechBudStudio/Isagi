import assert from 'node:assert/strict';
import test from 'node:test';

import { assembleEntries } from './entries.js';
import type { PaletteContext } from './types.js';

test('active worktree action entries freeze the active project and worktree ids', () => {
  const entries = assembleEntries(ctx());
  const entry = entries.find((candidate) => candidate.id === 'delete-active-worktree');

  assert.deepEqual(entry?.values, { projectId: '1', worktreeId: '11' });
});

function ctx(): PaletteContext {
  return {
    projects: [],
    activeProject: {
      id: 1,
      name: 'isagi',
      rootPath: '/repo/isagi',
      glyph: 'IS',
      accent: 'blue',
      status: 'present',
      worktrees: [],
    },
    activeWorktree: {
      id: 11,
      projectId: 1,
      title: 'feature/delete-me',
      path: '/repo/isagi-feature',
      branch: 'feature/delete-me',
      head: 'abcdef0',
      isRoot: false,
      attention: 'idle',
      parked: false,
      surfaces: [],
      activeSurfaceId: null,
    },
    activeSurface: null,
    activePaneId: null,
  };
}
