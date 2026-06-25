import assert from 'node:assert/strict';
import test from 'node:test';

import { assembleEntries } from './entries.js';
import type { PaletteContext } from './types.js';

test('active worktree action entries freeze the active project and worktree ids', () => {
  const entries = assembleEntries(ctx());
  const entry = entries.find((candidate) => candidate.id === 'delete-active-worktree');

  assert.deepEqual(entry?.values, { projectId: '1', worktreeId: '11' });
});

test('workflow descriptors assemble into workflow entries', () => {
  const entries = assembleEntries(
    ctx({
      workflowDescriptors: [
        {
          ok: true,
          workflowKey: 'release',
          manifest: {
            title: 'Release',
            description: 'Runs the release checklist.',
            inputs: [{ kind: 'text', key: 'version', label: 'Version' }],
          },
        },
      ],
    }),
  );

  const entry = entries.find((candidate) => candidate.id === 'workflow:release');
  assert.equal(entry?.group, 'workflows');
  assert.equal(entry?.label, 'Release');
  assert.equal(entry?.sub, 'Runs the release checklist.');
  assert.equal(entry?.workflow?.workflowKey, 'release');
  assert.equal(entry?.disabled, undefined);
});

test('broken workflow descriptors stay visible as disabled entries', () => {
  const entries = assembleEntries(
    ctx({
      workflowDescriptors: [{ ok: false, workflowKey: 'broken', message: 'Import failed.' }],
    }),
  );

  const entry = entries.find((candidate) => candidate.id === 'workflow:broken');
  assert.equal(entry?.group, 'workflows');
  assert.equal(entry?.label, 'broken');
  assert.equal(entry?.sub, 'Manifest did not load.');
  assert.deepEqual(entry?.disabled, { reason: 'Import failed.' });
});

test('workflow entries are disabled while the active surface is occupied', () => {
  const entries = assembleEntries(
    ctx({
      workflowDescriptors: [
        {
          ok: true,
          workflowKey: 'release',
          manifest: { title: 'Release' },
        },
      ],
      activeSurfaceWorkflowSummary: {
        surfaceId: 42,
        rootRunId: 99,
        status: 'done',
        title: 'Current workflow',
      },
    }),
  );

  const entry = entries.find((candidate) => candidate.id === 'workflow:release');
  assert.deepEqual(entry?.disabled, { reason: 'Dismiss the current workflow first.' });
  assert.equal(entry?.sub, 'Dismiss the current workflow first.');
});

function ctx(options: Partial<PaletteContext> = {}): PaletteContext {
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
      surfaces: [{ id: 42, title: 'Main', paneKinds: [], attention: 'idle' }],
      activeSurfaceId: 42,
    },
    activeSurface: { id: 42, title: 'Main', paneKinds: [], attention: 'idle' },
    activePaneId: null,
    ...options,
  };
}
