import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project, Surface } from '../workspace/types.js';
import { buildPaletteContext } from './context.js';

test('palette context carries active surface and frontend active pane target', () => {
  const surfaceA = surface({ id: 101, title: 'Agent' });
  const surfaceB = surface({ id: 102, title: 'Terminal' });
  const projects = [project({ surfaces: [surfaceA, surfaceB], activeSurfaceId: surfaceA.id })];

  const ctx = buildPaletteContext(projects, 10, {
    activeSurfaceByWorktreeId: { 10: surfaceB.id },
    activePaneBySurfaceId: { [surfaceB.id]: 501 },
  });

  assert.equal(ctx.activeProject?.id, 1);
  assert.equal(ctx.activeWorktree?.id, 10);
  assert.equal(ctx.activeSurface?.id, surfaceB.id);
  assert.equal(ctx.activePaneId, 501);
});

test('palette context ignores stale active surface overrides', () => {
  const surfaceA = surface({ id: 101, title: 'Agent' });
  const projects = [project({ surfaces: [surfaceA], activeSurfaceId: surfaceA.id })];

  const ctx = buildPaletteContext(projects, 10, {
    activeSurfaceByWorktreeId: { 10: 999 },
    activePaneBySurfaceId: { [surfaceA.id]: 501 },
  });

  assert.equal(ctx.activeSurface?.id, surfaceA.id);
  assert.equal(ctx.activePaneId, 501);
});

function surface(input: { readonly id: number; readonly title: string }): Surface {
  return {
    id: input.id,
    kind: 'terminal',
    title: input.title,
    attention: 'idle',
  };
}

function project(input: {
  readonly surfaces: readonly Surface[];
  readonly activeSurfaceId: number | null;
}): Project {
  return {
    id: 1,
    name: 'isagi',
    rootPath: '/repo/isagi',
    glyph: 'IS',
    accent: 'blue',
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
        attention: 'idle',
        parked: false,
        surfaces: input.surfaces,
        activeSurfaceId: input.activeSurfaceId,
        commands: [],
      },
    ],
  };
}
