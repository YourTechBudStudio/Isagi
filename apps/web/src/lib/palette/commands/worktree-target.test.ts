import assert from 'node:assert/strict';
import test from 'node:test';

import type { Surface } from '../../workspace/types.js';
import type { PaletteContext } from '../types.js';
import { emptySurfaceIdFromValues } from './worktree-target.js';

function ctx(activeSurface: Surface | null): PaletteContext {
  return {
    projects: [],
    launchableHarnesses: [],
    editorAvailable: false,
    activeProject: null,
    activeWorktree: null,
    activeSurface,
    activePaneId: null,
  };
}

const empty: Surface = { id: 7, title: 'Review', paneKinds: [], attention: 'idle' };
const occupied: Surface = {
  id: 8,
  title: 'Terminal',
  paneKinds: ['terminal_session'],
  attention: 'idle',
};

test('an explicit target surface always wins', () => {
  assert.equal(emptySurfaceIdFromValues({ intoSurfaceId: '9' }, ctx(occupied)), 9);
});

test('plain palette dispatch fills the active surface only when it is empty', () => {
  assert.equal(emptySurfaceIdFromValues({}, ctx(empty)), 7);
  assert.equal(emptySurfaceIdFromValues({}, ctx(occupied)), null);
  assert.equal(emptySurfaceIdFromValues({}, ctx(null)), null);
});

test('a command aimed at an explicit worktree never borrows the active empty surface', () => {
  assert.equal(emptySurfaceIdFromValues({ worktreeId: '3' }, ctx(empty)), null);
});
