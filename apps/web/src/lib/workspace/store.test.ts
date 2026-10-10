// Workbench interaction state: each action is one transition over the registry's atoms.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTestRegistry } from '../state/testing.js';
import {
  activePaneBySurfaceAtom,
  activeSurfaceByWorktreeAtom,
  closeDrawer,
  drawerAtom,
  emptyWorkspaceSelection,
  forgetPane,
  forgetSurface,
  openDrawer,
  selectCommand,
  selectionAtom,
  selectMissingProject,
  selectWorktree,
  setActivePane,
  setActiveSurface,
  toggleZen,
  zenAtom,
} from './store.js';

test('a new registry starts with an empty selection, no overrides, a closed drawer and no zen', (t) => {
  const registry = makeTestRegistry();
  t.after(() => registry.dispose());

  assert.equal(registry.get(selectionAtom), emptyWorkspaceSelection);
  assert.deepEqual(registry.get(activeSurfaceByWorktreeAtom), {});
  assert.deepEqual(registry.get(activePaneBySurfaceAtom), {});
  assert.deepEqual(registry.get(drawerAtom), { open: false, selectedCommandId: null });
  assert.equal(registry.get(zenAtom), false);
});

test('selecting a missing project closes the drawer in the same notification', (t) => {
  const registry = makeTestRegistry();
  t.after(() => registry.dispose());
  selectWorktree(registry, 1, 10);
  openDrawer(registry, 'dev');
  const seen: string[] = [];
  const stopSelection = registry.subscribe(selectionAtom, (selection) =>
    seen.push(`selection:${selection.kind}:drawer-open=${registry.get(drawerAtom).open}`),
  );
  const stopDrawer = registry.subscribe(drawerAtom, (drawer) =>
    seen.push(`drawer-open=${drawer.open}:selection=${registry.get(selectionAtom).kind}`),
  );
  t.after(() => {
    stopSelection();
    stopDrawer();
  });

  selectMissingProject(registry, 1);

  // Every listener already sees both halves of the transition.
  assert.deepEqual(seen.sort(), [
    'drawer-open=false:selection=missingProject',
    'selection:missingProject:drawer-open=false',
  ]);
  assert.deepEqual(registry.get(drawerAtom), { open: false, selectedCommandId: null });
});

test('forgetting a surface or pane only clears an override that still names it', (t) => {
  const registry = makeTestRegistry();
  t.after(() => registry.dispose());
  setActiveSurface(registry, 10, 101);
  setActiveSurface(registry, 20, 201);
  setActivePane(registry, 101, 1);
  setActivePane(registry, 201, 2);

  forgetSurface(registry, 10, 999);
  forgetPane(registry, 101, 999);
  assert.deepEqual(registry.get(activeSurfaceByWorktreeAtom), { 10: 101, 20: 201 });
  assert.deepEqual(registry.get(activePaneBySurfaceAtom), { 101: 1, 201: 2 });

  forgetSurface(registry, 10, 101);
  forgetPane(registry, 101, 1);
  forgetPane(registry, 201);
  assert.deepEqual(registry.get(activeSurfaceByWorktreeAtom), { 20: 201 });
  assert.deepEqual(registry.get(activePaneBySurfaceAtom), {});
});

test('the drawer keeps its selected command across close and a bare reopen', (t) => {
  const registry = makeTestRegistry();
  t.after(() => registry.dispose());

  openDrawer(registry, 'dev');
  closeDrawer(registry);
  openDrawer(registry);
  assert.deepEqual(registry.get(drawerAtom), { open: true, selectedCommandId: 'dev' });

  selectCommand(registry, 'test');
  assert.deepEqual(registry.get(drawerAtom), { open: true, selectedCommandId: 'test' });
});

test('zen toggles', (t) => {
  const registry = makeTestRegistry();
  t.after(() => registry.dispose());

  toggleZen(registry);
  assert.equal(registry.get(zenAtom), true);
  toggleZen(registry);
  assert.equal(registry.get(zenAtom), false);
});
