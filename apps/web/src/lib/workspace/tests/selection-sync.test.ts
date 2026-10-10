// The selection restoration decision (`nextSelectionSync`), branch by branch, and the hooks'
// per-session memory (`selectionSyncAtom`).
import assert from 'node:assert/strict';
import test from 'node:test';

import { makeTestRegistry } from '../../state/testing.js';
import {
  nextSelectionSync,
  selectionSyncAtom,
  type SelectionSyncInput,
} from '../selection-sync.js';
import type { WorkspaceSelection } from '../types.js';
import { project, worktree } from './test-support.js';

const app = project({
  id: 1,
  name: 'app',
  worktrees: [worktree({ id: 10, projectId: 1, isRoot: true }), worktree({ id: 11, projectId: 1 })],
});
const lib = project({ id: 2, name: 'lib' });
const gone = project({ id: 3, name: 'gone', status: 'missing' });

const decide = (input: Partial<SelectionSyncInput>) =>
  nextSelectionSync({
    selection: { kind: 'empty' },
    projects: [app, lib],
    activeContext: undefined,
    activeContextError: false,
    reconciled: new Set(),
    ...input,
  });

test('nothing is decided before the first workspace snapshot', () => {
  const decision = decide({
    projects: undefined,
    activeContext: { projectId: 1, worktreeId: 11 },
  });

  assert.deepEqual(decision, {
    next: null,
    toasts: [],
    reconcileProjectId: null,
    suppressPersistence: false,
  });
});

test('an empty selection waits for the active context; nothing restorable is a no-op', () => {
  const decision = decide({ activeContext: undefined });

  assert.equal(decision.next, null);
  assert.deepEqual(decision.toasts, []);
  assert.equal(decision.reconcileProjectId, null);
});

test('startup hydrates the selection from the persisted active context', () => {
  const decision = decide({ activeContext: { projectId: 1, worktreeId: 11 } });

  assert.deepEqual(decision.next, { kind: 'worktree', projectId: 1, worktreeId: 11 });
  assert.deepEqual(decision.toasts, []);
  // A restoration is not a user choice: its echo must not be written back to the runtime.
  assert.equal(decision.suppressPersistence, true);
  // The restored project is reconciled in the background, once.
  assert.equal(decision.reconcileProjectId, 1);
});

test('a project already reconciled for a restoration is not reconciled again', () => {
  const decision = decide({
    activeContext: { projectId: 1, worktreeId: 11 },
    reconciled: new Set([1]),
  });

  assert.equal(decision.reconcileProjectId, null);
  assert.deepEqual(decision.next, { kind: 'worktree', projectId: 1, worktreeId: 11 });
});

test('a failed active-context read warns and falls back to the default selection', () => {
  const decision = decide({ activeContextError: true });

  assert.deepEqual(
    decision.toasts.map(({ id }) => id),
    ['active-context-load-failed'],
  );
  assert.deepEqual(decision.next, { kind: 'worktree', projectId: 1, worktreeId: 10 });
  assert.equal(decision.suppressPersistence, true);
});

test('a restored project that is missing opens its recovery state', () => {
  const decision = decide({
    projects: [app, gone],
    activeContext: { projectId: 3, worktreeId: null },
  });

  assert.deepEqual(decision.next, { kind: 'missingProject', projectId: 3 });
});

test('a selected worktree that disappeared moves to its root with a recovery warning', () => {
  const selection: WorkspaceSelection = { kind: 'worktree', projectId: 1, worktreeId: 12 };
  const decision = decide({ selection });

  assert.deepEqual(decision.next, { kind: 'worktree', projectId: 1, worktreeId: 10 });
  assert.deepEqual(
    decision.toasts.map(({ id }) => id),
    ['active-worktree-recovered:12'],
  );
  // A user selection that had to move is persisted as usual.
  assert.equal(decision.suppressPersistence, false);
  assert.equal(decision.reconcileProjectId, null);
});

test('a selected project that went missing moves to its recovery state without a warning', () => {
  const selection: WorkspaceSelection = { kind: 'worktree', projectId: 3, worktreeId: 30 };
  const decision = decide({ selection, projects: [app, gone] });

  assert.deepEqual(decision.next, { kind: 'missingProject', projectId: 3 });
  assert.deepEqual(decision.toasts, []);
});

test('a selection that still exists is left alone', () => {
  const selection: WorkspaceSelection = { kind: 'worktree', projectId: 1, worktreeId: 11 };

  assert.deepEqual(decide({ selection, activeContext: { projectId: 2, worktreeId: null } }), {
    next: null,
    toasts: [],
    reconcileProjectId: null,
    suppressPersistence: false,
  });
});

test('the sync memory belongs to one app session', (t) => {
  const first = makeTestRegistry();
  const second = makeTestRegistry();
  t.after(() => {
    first.dispose();
    second.dispose();
  });

  first.get(selectionSyncAtom).reconciledProjectIds.add(1);
  first.get(selectionSyncAtom).suppressedPersistence = { kind: 'empty' };

  assert.equal(first.get(selectionSyncAtom).reconciledProjectIds.has(1), true);
  assert.equal(second.get(selectionSyncAtom).reconciledProjectIds.size, 0);
  assert.equal(second.get(selectionSyncAtom).suppressedPersistence, null);
});
