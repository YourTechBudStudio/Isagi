import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  isDeletePending,
  isRunDeleteBlocked,
  paneDeleteKey,
  showsDeleteSweep,
  surfaceDeleteKey,
  usePendingDeleteStore,
} from './pending-deletes.js';

const store = () => usePendingDeleteStore.getState();
const entryFor = (key: string) => usePendingDeleteStore.getState().entriesByKey[key] ?? null;

describe('pending deletes', () => {
  beforeEach(() => {
    usePendingDeleteStore.setState({ entriesByKey: {} });
  });

  it('keys panes and surfaces apart so one delete never locks the other', () => {
    assert.notEqual(paneDeleteKey(7), surfaceDeleteKey(7));
  });

  it('tracks a delete from begin to clear', () => {
    const key = paneDeleteKey(4);
    assert.equal(isDeletePending(entryFor(key)), false);

    store().beginDelete(key, 'pane');
    assert.equal(isDeletePending(entryFor(key)), true);

    store().clearDelete(key);
    assert.equal(entryFor(key), null);
  });

  it('draws the sweep only at the origin that started the delete', () => {
    const key = paneDeleteKey(4);
    store().beginDelete(key, 'menu');

    assert.equal(showsDeleteSweep(entryFor(key), 'menu'), true);
    assert.equal(showsDeleteSweep(entryFor(key), 'pane'), false);
  });

  it('releases the target once a delete fails, and stops sweeping', () => {
    const key = surfaceDeleteKey(2);
    store().beginDelete(key, 'menu');
    store().failDelete(key, 'worktree is locked');

    const entry = entryFor(key);
    // A failure is a result the user still has to read, not work in progress:
    // the affordances come back so they can retry or walk away.
    assert.equal(entry?.error, 'worktree is locked');
    assert.equal(isDeletePending(entry), false);
    assert.equal(showsDeleteSweep(entry, 'menu'), false);
  });

  it('ignores a failure for a target that is no longer in flight', () => {
    const key = surfaceDeleteKey(2);
    store().failDelete(key, 'too late');
    assert.equal(entryFor(key), null);
  });

  it('blocks a pane delete while its owning surface is being deleted', () => {
    store().beginDelete(surfaceDeleteKey(2), 'menu');

    assert.equal(
      isRunDeleteBlocked(
        {
          key: paneDeleteKey(4),
          origin: 'pane',
          commandId: 'delete-active-pane',
          surfaceId: 2,
          values: { surfaceId: '2', paneId: '4' },
        },
        store().entriesByKey,
      ),
      true,
    );
  });
});
