// Toasts are per app session: the actions write one registry's list and nothing else.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTestRegistry } from '../state/testing.js';
import { MAX_VISIBLE_TOASTS } from './constants.js';
import { clearToasts, dismissToast, showToast, toastsAtom } from './store.js';

test('a toast is shown newest first and a repeated id replaces the earlier one', (t) => {
  const registry = makeTestRegistry();
  t.after(() => registry.dispose());

  const first = showToast(registry, { id: 'a', kind: 'info', title: 'A' });
  showToast(registry, { id: 'b', kind: 'info', title: 'B' });
  showToast(registry, { id: 'a', kind: 'warning', title: 'A again' });

  assert.equal(first, 'a');
  assert.deepEqual(
    registry.get(toastsAtom).map((toast) => [toast.id, toast.title]),
    [
      ['a', 'A again'],
      ['b', 'B'],
    ],
  );
});

test('a toast without an id or lifetime gets a generated id and auto-dismisses', (t) => {
  const registry = makeTestRegistry();
  t.after(() => registry.dispose());

  const id = showToast(registry, { kind: 'success', title: 'Saved' });
  const [toast] = registry.get(toastsAtom);

  assert.equal(toast?.id, id);
  assert.match(id, /^toast-/);
  assert.equal(toast?.lifetime.autoDismiss, true);
});

test('past the visible cap the oldest auto-dismissing toast goes, a sticky one stays', (t) => {
  const registry = makeTestRegistry();
  t.after(() => registry.dispose());

  showToast(registry, {
    id: 'sticky',
    kind: 'warning',
    title: 'S',
    lifetime: { autoDismiss: false },
  });
  for (let index = 0; index < MAX_VISIBLE_TOASTS; index += 1) {
    showToast(registry, { id: `t${index}`, kind: 'info', title: `T${index}` });
  }

  const ids = registry.get(toastsAtom).map((toast) => toast.id);
  assert.equal(ids.length, MAX_VISIBLE_TOASTS);
  assert.ok(ids.includes('sticky'));
  assert.ok(!ids.includes('t0'), 'the oldest auto-dismissing toast was evicted');
});

test('dismiss removes one toast and clear removes all, in their own registry only', (t) => {
  const registry = makeTestRegistry();
  const other = makeTestRegistry();
  t.after(() => {
    registry.dispose();
    other.dispose();
  });

  showToast(registry, { id: 'a', kind: 'info', title: 'A' });
  showToast(registry, { id: 'b', kind: 'info', title: 'B' });
  showToast(other, { id: 'a', kind: 'info', title: 'Other A' });

  dismissToast(registry, 'a');
  assert.deepEqual(
    registry.get(toastsAtom).map((toast) => toast.id),
    ['b'],
  );

  clearToasts(registry);
  assert.deepEqual(registry.get(toastsAtom), []);
  assert.deepEqual(
    other.get(toastsAtom).map((toast) => toast.title),
    ['Other A'],
  );
});
