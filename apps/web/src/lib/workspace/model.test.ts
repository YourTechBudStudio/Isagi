import assert from 'node:assert/strict';
import test from 'node:test';

import { activeContextFromSelection, selectionFromActiveContext } from './model.js';
import type { Project } from './types.js';

const missingA = project({ id: 1, name: 'missing-a', status: 'missing' });
const missingB = project({ id: 2, name: 'missing-b', status: 'missing' });
const present = project({ id: 3, name: 'present', status: 'present' });

test('project-only active context restores the specific missing project recovery state', () => {
  assert.deepEqual(
    selectionFromActiveContext([missingA, missingB, present], {
      projectId: missingB.id,
      worktreeId: null,
    }),
    {
      kind: 'missingProject',
      projectId: missingB.id,
    },
  );
});

test('missing restored worktree falls back to the same project root', () => {
  assert.deepEqual(
    selectionFromActiveContext([present, project({ id: 4, name: 'other', status: 'present' })], {
      projectId: present.id,
      worktreeId: 999,
    }),
    {
      kind: 'worktree',
      projectId: present.id,
      worktreeId: present.worktrees[0]!.id,
    },
  );
});

test('transient missing-project selection is not converted into persisted active context', () => {
  assert.equal(
    activeContextFromSelection({ kind: 'missingProject', projectId: missingA.id }),
    null,
  );
});

function project(input: {
  readonly id: number;
  readonly name: string;
  readonly status: 'present' | 'missing';
}): Project {
  return {
    id: input.id,
    name: input.name,
    rootPath: `/repo/${input.name}`,
    status: input.status,
    glyph: input.name.slice(0, 2).toUpperCase(),
    accent: 'blue',
    worktrees:
      input.status === 'present'
        ? [
            {
              id: input.id * 10,
              projectId: input.id,
              title: 'main',
              path: `/repo/${input.name}`,
              branch: 'main',
              head: 'abcdef0',
              isRoot: true,
              attention: 'idle',
              parked: false,
              surfaces: [],
              activeSurfaceId: null,
              commands: [],
            },
          ]
        : [],
    ...(input.status === 'missing' ? { missingReason: 'Project path not found.' } : {}),
  };
}
