// Palette chrome state: open, autostart target and recents, one set per app session.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTestRegistry } from '../state/testing.js';
import { closePalette, isPaletteOpen, openPalette, paletteAtom, pushRecent } from './store.js';

test('opening into an entry records the autostart target, closing clears it and keeps recents', (t) => {
  const registry = makeTestRegistry();
  t.after(() => registry.dispose());

  pushRecent(registry, 'open-worktree');
  openPalette(registry, 'relocate-project', { projectId: '7' });

  assert.equal(isPaletteOpen(registry), true);
  assert.deepEqual(registry.get(paletteAtom), {
    open: true,
    autostartEntryId: 'relocate-project',
    autostartValues: { projectId: '7' },
    recents: ['open-worktree'],
  });

  closePalette(registry);
  assert.deepEqual(registry.get(paletteAtom), {
    open: false,
    autostartEntryId: null,
    autostartValues: {},
    recents: ['open-worktree'],
  });
  assert.equal(isPaletteOpen(registry), false);
});

test('a plain open has no autostart target', (t) => {
  const registry = makeTestRegistry();
  t.after(() => registry.dispose());

  openPalette(registry);

  assert.equal(registry.get(paletteAtom).autostartEntryId, null);
  assert.deepEqual(registry.get(paletteAtom).autostartValues, {});
});

test('recents are most-recent-first, de-duplicated and capped at twelve', (t) => {
  const registry = makeTestRegistry();
  t.after(() => registry.dispose());

  for (let index = 0; index < 14; index += 1) {
    pushRecent(registry, `entry-${index}`);
  }
  pushRecent(registry, 'entry-5');

  const { recents } = registry.get(paletteAtom);
  assert.equal(recents.length, 12);
  assert.equal(recents[0], 'entry-5');
  assert.equal(recents.filter((id) => id === 'entry-5').length, 1);
  assert.ok(!recents.includes('entry-0'), 'the oldest entries fall off');
});
