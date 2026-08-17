import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { usePaletteStore } from '../../palette/store.js';
import { queryClient } from '../../query/client.js';
import {
  activatePane,
  paneFocusAllowed,
  registerDrawerFocusTarget,
  registerPaneFocusTarget,
  restoreWorkbenchFocus,
} from '../activation.js';
import { workspaceQueryKey } from '../query-keys.js';
import { useWorkspaceStore } from '../store.js';
import { project, surface, workspace, worktree } from './test-support.js';

// The scheduler's deferred path needs `window.requestAnimationFrame`; in this
// node environment `scheduleFocus` takes its synchronous fallback instead, so
// every focus request below resolves within the calling statement and no frame
// plumbing is needed.

const WORKTREE_ID = 10;
const SURFACE_ID = 21;
const PANE_ID = 31;

function seedWorkspace() {
  queryClient.setQueryData(
    workspaceQueryKey,
    workspace([
      project({
        id: 1,
        name: 'isagi',
        worktrees: [
          {
            ...worktree({ id: WORKTREE_ID, projectId: 1, isRoot: true }),
            surfaces: [surface({ id: SURFACE_ID })],
            activeSurfaceId: SURFACE_ID,
          },
        ],
      }),
    ]),
  );
  const store = useWorkspaceStore.getState();
  store.selectWorktree(1, WORKTREE_ID);
  store.setActiveSurface(WORKTREE_ID, SURFACE_ID);
  store.setActivePane(SURFACE_ID, PANE_ID);
}

const cleanups: (() => void)[] = [];

/**
 * Register a recording pane target. Registration itself re-requests focus when
 * the key matches the active pane, so `calls` is reset afterwards and only
 * records what the assertion under test caused.
 */
function recordingPaneTarget() {
  const calls: string[] = [];
  cleanups.push(
    registerPaneFocusTarget({
      surfaceId: SURFACE_ID,
      paneId: PANE_ID,
      focus: () => calls.push('pane'),
    }),
  );
  calls.length = 0;
  return calls;
}

afterEach(() => {
  // Unconditional, so a failing assertion cannot leak a registration into the
  // next test through this module's process-wide registry.
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  useWorkspaceStore.getState().closeDrawer();
  usePaletteStore.getState().closePalette();
  queryClient.clear();
});

describe('workbench focus router', () => {
  it('routes to the registered drawer target while the drawer is open', () => {
    const drawerCalls: string[] = [];
    const paneCalls: string[] = [];
    cleanups.push(registerDrawerFocusTarget(() => drawerCalls.push('drawer')));
    useWorkspaceStore.getState().openDrawer();

    restoreWorkbenchFocus(() => paneCalls.push('pane'));

    assert.deepEqual(drawerCalls, ['drawer']);
    assert.deepEqual(paneCalls, [], 'pane restore would misdirect keystrokes behind the drawer');
  });

  it('suppresses pane restore when the drawer is open but not yet registered', () => {
    const paneCalls: string[] = [];
    useWorkspaceStore.getState().openDrawer();

    restoreWorkbenchFocus(() => paneCalls.push('pane'));

    // Doing nothing is the point: the drawer mounted in this same commit and
    // its own focus-on-open effect lands focus. A pane restore here would
    // schedule a deferred focus that steals it back.
    assert.deepEqual(paneCalls, []);
  });

  it('falls back to pane restore when the drawer is closed', () => {
    const paneCalls: string[] = [];

    restoreWorkbenchFocus(() => paneCalls.push('pane'));

    assert.deepEqual(paneCalls, ['pane']);
  });

  it('lets an older unregister clear only its own registration', () => {
    const calls: string[] = [];
    const unregisterA = registerDrawerFocusTarget(() => calls.push('a'));
    cleanups.push(registerDrawerFocusTarget(() => calls.push('b')));
    useWorkspaceStore.getState().openDrawer();

    unregisterA();
    restoreWorkbenchFocus(() => calls.push('pane'));

    assert.deepEqual(calls, ['b'], 'a stale cleanup must not strand the newer target');
  });
});

describe('pane focus ownership guard', () => {
  it('drops a pane-focus request that fires while the drawer is open', () => {
    seedWorkspace();
    useWorkspaceStore.getState().openDrawer();
    const calls = recordingPaneTarget();

    activatePane(
      { worktreeId: WORKTREE_ID, surfaceId: SURFACE_ID, paneId: PANE_ID },
      { persist: false },
    );

    assert.deepEqual(calls, []);
  });

  it('drops a pane-focus request that fires while the palette is open', () => {
    seedWorkspace();
    usePaletteStore.getState().openPalette();
    const calls = recordingPaneTarget();

    activatePane(
      { worktreeId: WORKTREE_ID, surfaceId: SURFACE_ID, paneId: PANE_ID },
      { persist: false },
    );

    assert.deepEqual(calls, [], 'a busy or open palette owns focus, not the pane');
  });

  it('focuses the pane when both overlays are closed', () => {
    seedWorkspace();
    const calls = recordingPaneTarget();

    activatePane(
      { worktreeId: WORKTREE_ID, surfaceId: SURFACE_ID, paneId: PANE_ID },
      { persist: false },
    );

    assert.deepEqual(calls, ['pane'], 'the guard blocks overlays, not ordinary pane activation');
  });

  it('does not replay a dropped request after the overlay closes', () => {
    seedWorkspace();
    useWorkspaceStore.getState().openDrawer();
    const calls = recordingPaneTarget();
    activatePane(
      { worktreeId: WORKTREE_ID, surfaceId: SURFACE_ID, paneId: PANE_ID },
      { persist: false },
    );
    assert.deepEqual(calls, []);

    // Closing the overlay must not resurrect the obsolete request: each
    // overlay's close path is the explicit, correctly ordered way pane focus
    // returns. The dropped request cleared `pendingFocusKey` for exactly this.
    useWorkspaceStore.getState().closeDrawer();

    assert.deepEqual(calls, []);
  });
});

describe('paneFocusAllowed', () => {
  it('is false while the palette is open', () => {
    usePaletteStore.getState().openPalette();
    assert.equal(paneFocusAllowed(), false);
  });

  it('is false while the drawer is open', () => {
    useWorkspaceStore.getState().openDrawer();
    assert.equal(paneFocusAllowed(), false);
  });

  it('is false while both are open', () => {
    usePaletteStore.getState().openPalette();
    useWorkspaceStore.getState().openDrawer();
    assert.equal(paneFocusAllowed(), false);
  });

  it('is true only when neither overlay is open', () => {
    assert.equal(paneFocusAllowed(), true);
  });
});
