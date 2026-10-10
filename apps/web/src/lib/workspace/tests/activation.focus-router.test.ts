import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Effect } from 'effect';
import type { AtomRegistry } from 'effect/reactivity';

import { openPalette } from '../../palette/store.js';
import { makeTestRegistry } from '../../state/testing.js';
import {
  activatePane,
  paneFocusAllowed,
  registerDrawerFocusTarget,
  registerPaneFocusTarget,
  restoreWorkbenchFocus,
} from '../activation.js';
import { cachedWorkspaceData, workspaceAtom } from '../queries.js';
import {
  closeDrawer,
  openDrawer,
  selectWorktree,
  setActivePane,
  setActiveSurface,
} from '../store.js';
import { project, snapshotOf, surface, workspace, worktree } from './test-support.js';

// The scheduler's deferred path needs `window.requestAnimationFrame`; in this
// node environment `scheduleFocus` takes its synchronous fallback instead, so
// every focus request below resolves within the calling statement and no frame
// plumbing is needed.

const WORKTREE_ID = 10;
const SURFACE_ID = 21;
const PANE_ID = 31;

const seed = workspace([
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
]);

/** Hold the workspace (the fake answers synchronously, so it is there at once) and select it. */
function seedWorkspace() {
  cleanups.push(registry.mount(workspaceAtom));
  assert.ok(cachedWorkspaceData(registry), 'the seeded workspace is held');
  selectWorktree(registry, 1, WORKTREE_ID);
  setActiveSurface(registry, WORKTREE_ID, SURFACE_ID);
  setActivePane(registry, SURFACE_ID, PANE_ID);
}

const cleanups: (() => void)[] = [];
let registry: AtomRegistry.AtomRegistry;

beforeEach(() => {
  // A fresh app session per test: the focus router's state is per registry.
  registry = makeTestRegistry({
    api: { fetchWorkspace: () => Effect.succeed(snapshotOf(seed)) },
  });
});

/**
 * Register a recording pane target. Registration itself re-requests focus when
 * the key matches the active pane, so `calls` is reset afterwards and only
 * records what the assertion under test caused.
 */
function recordingPaneTarget() {
  const calls: string[] = [];
  cleanups.push(
    registerPaneFocusTarget(registry, {
      surfaceId: SURFACE_ID,
      paneId: PANE_ID,
      focus: () => calls.push('pane'),
    }),
  );
  calls.length = 0;
  return calls;
}

afterEach(() => {
  // Unconditional, so a failing assertion cannot leak a registration or a mount
  // past this test's registry.
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  registry.dispose();
});

describe('workbench focus router', () => {
  it('routes to the registered drawer target while the drawer is open', () => {
    const drawerCalls: string[] = [];
    const paneCalls: string[] = [];
    cleanups.push(registerDrawerFocusTarget(registry, () => drawerCalls.push('drawer')));
    openDrawer(registry);

    restoreWorkbenchFocus(registry, () => paneCalls.push('pane'));

    assert.deepEqual(drawerCalls, ['drawer']);
    assert.deepEqual(paneCalls, [], 'pane restore would misdirect keystrokes behind the drawer');
  });

  it('suppresses pane restore when the drawer is open but not yet registered', () => {
    const paneCalls: string[] = [];
    openDrawer(registry);

    restoreWorkbenchFocus(registry, () => paneCalls.push('pane'));

    // Doing nothing is the point: the drawer mounted in this same commit and
    // its own focus-on-open effect lands focus. A pane restore here would
    // schedule a deferred focus that steals it back.
    assert.deepEqual(paneCalls, []);
  });

  it('falls back to pane restore when the drawer is closed', () => {
    const paneCalls: string[] = [];

    restoreWorkbenchFocus(registry, () => paneCalls.push('pane'));

    assert.deepEqual(paneCalls, ['pane']);
  });

  it('lets an older unregister clear only its own registration', () => {
    const calls: string[] = [];
    const unregisterA = registerDrawerFocusTarget(registry, () => calls.push('a'));
    cleanups.push(registerDrawerFocusTarget(registry, () => calls.push('b')));
    openDrawer(registry);

    unregisterA();
    restoreWorkbenchFocus(registry, () => calls.push('pane'));

    assert.deepEqual(calls, ['b'], 'a stale cleanup must not strand the newer target');
  });
});

describe('pane focus ownership guard', () => {
  it('drops a pane-focus request that fires while the drawer is open', () => {
    seedWorkspace();
    openDrawer(registry);
    const calls = recordingPaneTarget();

    activatePane(
      registry,
      { worktreeId: WORKTREE_ID, surfaceId: SURFACE_ID, paneId: PANE_ID },
      { persist: false },
    );

    assert.deepEqual(calls, []);
  });

  it('drops a pane-focus request that fires while the palette is open', () => {
    seedWorkspace();
    openPalette(registry);
    const calls = recordingPaneTarget();

    activatePane(
      registry,
      { worktreeId: WORKTREE_ID, surfaceId: SURFACE_ID, paneId: PANE_ID },
      { persist: false },
    );

    assert.deepEqual(calls, [], 'a busy or open palette owns focus, not the pane');
  });

  it('focuses the pane when both overlays are closed', () => {
    seedWorkspace();
    const calls = recordingPaneTarget();

    activatePane(
      registry,
      { worktreeId: WORKTREE_ID, surfaceId: SURFACE_ID, paneId: PANE_ID },
      { persist: false },
    );

    assert.deepEqual(calls, ['pane'], 'the guard blocks overlays, not ordinary pane activation');
  });

  it('does not replay a dropped request after the overlay closes', () => {
    seedWorkspace();
    openDrawer(registry);
    const calls = recordingPaneTarget();
    activatePane(
      registry,
      { worktreeId: WORKTREE_ID, surfaceId: SURFACE_ID, paneId: PANE_ID },
      { persist: false },
    );
    assert.deepEqual(calls, []);

    // Closing the overlay must not resurrect the obsolete request: each
    // overlay's close path is the explicit, correctly ordered way pane focus
    // returns. The dropped request cleared `pendingFocusKey` for exactly this.
    closeDrawer(registry);

    assert.deepEqual(calls, []);
  });
});

describe('paneFocusAllowed', () => {
  it('is false while the palette is open', () => {
    openPalette(registry);
    assert.equal(paneFocusAllowed(registry), false);
  });

  it('is false while the drawer is open', () => {
    openDrawer(registry);
    assert.equal(paneFocusAllowed(registry), false);
  });

  it('is false while both are open', () => {
    openPalette(registry);
    openDrawer(registry);
    assert.equal(paneFocusAllowed(registry), false);
  });

  it('is true only when neither overlay is open', () => {
    assert.equal(paneFocusAllowed(registry), true);
  });
});

describe('per app session', () => {
  it("keeps each registry's focus targets to itself", (t) => {
    const other = makeTestRegistry();
    t.after(() => other.dispose());
    const calls: string[] = [];
    cleanups.push(registerDrawerFocusTarget(registry, () => calls.push('this session')));
    openDrawer(registry);
    openDrawer(other);

    restoreWorkbenchFocus(other, () => calls.push('pane'));

    // The other session's drawer is open but registered nothing: it must not reach this one's.
    assert.deepEqual(calls, []);
  });
});
