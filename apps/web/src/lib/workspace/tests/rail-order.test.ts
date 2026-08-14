import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkspaceData } from '../model.js';
import {
  applyRailMove,
  moveBefore,
  railMoveSiteExists,
  railSiblingIds,
  restoreRailOrder,
  scopeKey,
  type RailOrderScope,
} from '../rail-order.js';
import { project, surface, workspace, worktree } from './test-support.js';

const PROJECTS: RailOrderScope = { kind: 'projects' };
const WORKTREES: RailOrderScope = { kind: 'worktrees', projectId: 1 };
const SURFACES: RailOrderScope = { kind: 'surfaces', worktreeId: 12 };

/**
 * One project with a pinned root and two reorderable worktrees, the second of
 * which owns three surfaces — so every scope is exercisable against one snapshot.
 */
function seed(): WorkspaceData {
  return workspace([
    project({
      id: 1,
      name: 'isagi',
      worktrees: [
        worktree({ id: 10, projectId: 1, isRoot: true }),
        worktree({ id: 11, projectId: 1 }),
        worktree({
          id: 12,
          projectId: 1,
          surfaces: [surface({ id: 121 }), surface({ id: 122 }), surface({ id: 123 })],
        }),
      ],
    }),
    project({ id: 2, name: 'atlas' }),
    project({ id: 3, name: 'gone', status: 'missing' }),
  ]);
}

function projectIds(data: WorkspaceData) {
  return data.projects.map((candidate) => candidate.id);
}

function worktreeIds(data: WorkspaceData, projectId = 1) {
  return (
    data.projects
      .find((candidate) => candidate.id === projectId)
      ?.worktrees.map((candidate) => candidate.id) ?? []
  );
}

function surfaceIds(data: WorkspaceData, worktreeId = 12) {
  for (const candidate of data.projects) {
    const found = candidate.worktrees.find((entry) => entry.id === worktreeId);
    if (found) return found.surfaces.map((entry) => entry.id);
  }
  return [];
}

test('scope keys match the drag engine spellings', () => {
  assert.equal(scopeKey(PROJECTS), 'projects');
  assert.equal(scopeKey({ kind: 'worktrees', projectId: 7 }), 'worktrees:7');
  assert.equal(scopeKey({ kind: 'surfaces', worktreeId: 9 }), 'surfaces:9');
});

test('moveBefore covers start, middle, end, and append', () => {
  assert.deepEqual(moveBefore([1, 2, 3], 3, 1), [3, 1, 2]);
  assert.deepEqual(moveBefore([1, 2, 3], 1, 3), [2, 1, 3]);
  assert.deepEqual(moveBefore([1, 2, 3], 1, null), [2, 3, 1]);
  assert.deepEqual(moveBefore([1], 1, null), [1]);
});

test('moveBefore leaves the sequence alone for a no-op or an unknown participant', () => {
  const ids = [1, 2, 3];
  // Already sitting before its anchor: the same order, recomputed.
  assert.deepEqual(moveBefore(ids, 1, 2), ids);
  // Dropped on itself, moved item gone, anchor gone: nothing to compute at all.
  assert.equal(moveBefore(ids, 2, 2), ids);
  assert.equal(moveBefore(ids, 99, 1), ids);
  assert.equal(moveBefore(ids, 1, 99), ids);
});

test('sibling ids expose only reorderable members and tell absent from empty', () => {
  const data = seed();
  // Disconnected project 3 is not part of the present-project order.
  assert.deepEqual(railSiblingIds(data, PROJECTS), [1, 2]);
  // The pinned root 10 is excluded.
  assert.deepEqual(railSiblingIds(data, WORKTREES), [11, 12]);
  assert.deepEqual(railSiblingIds(data, SURFACES), [121, 122, 123]);
  // A legal but empty list is `[]`; a list whose parent is gone is `null`.
  assert.deepEqual(railSiblingIds(data, { kind: 'worktrees', projectId: 2 }), []);
  assert.equal(railSiblingIds(data, { kind: 'worktrees', projectId: 404 }), null);
  assert.equal(railSiblingIds(data, { kind: 'surfaces', worktreeId: 404 }), null);
});

test('project moves stay inside the present section', () => {
  const data = seed();
  assert.deepEqual(
    projectIds(applyRailMove(data, { scope: PROJECTS, movedId: 2, beforeId: 1 })),
    [2, 1, 3],
  );
  // Appending lands at the end of the present projects, above Disconnected —
  // never after the missing project, an order the runtime would never return.
  assert.deepEqual(
    projectIds(applyRailMove(data, { scope: PROJECTS, movedId: 1, beforeId: null })),
    [2, 1, 3],
  );
});

test('a disconnected project is not reorderable and not a legal anchor', () => {
  const data = seed();
  assert.equal(applyRailMove(data, { scope: PROJECTS, movedId: 3, beforeId: 1 }), data);
  assert.equal(applyRailMove(data, { scope: PROJECTS, movedId: 1, beforeId: 3 }), data);
});

test('worktree moves keep the root pinned at the head', () => {
  const data = seed();
  const moved = applyRailMove(data, { scope: WORKTREES, movedId: 12, beforeId: 11 });
  assert.deepEqual(worktreeIds(moved), [10, 12, 11]);
  const appended = applyRailMove(data, { scope: WORKTREES, movedId: 11, beforeId: null });
  assert.deepEqual(worktreeIds(appended), [10, 12, 11]);
});

test('the root worktree can be neither dragged nor used as an anchor', () => {
  const data = seed();
  assert.equal(applyRailMove(data, { scope: WORKTREES, movedId: 10, beforeId: 11 }), data);
  assert.equal(applyRailMove(data, { scope: WORKTREES, movedId: 12, beforeId: 10 }), data);
});

test('a project with no derived root treats every worktree as reorderable', () => {
  const data = workspace([
    project({
      id: 1,
      name: 'rootless',
      worktrees: [worktree({ id: 11, projectId: 1 }), worktree({ id: 12, projectId: 1 })],
    }),
  ]);
  assert.deepEqual(railSiblingIds(data, WORKTREES), [11, 12]);
  assert.deepEqual(
    worktreeIds(applyRailMove(data, { scope: WORKTREES, movedId: 12, beforeId: 11 })),
    [12, 11],
  );
});

test('surface moves reorder within one worktree', () => {
  const data = seed();
  assert.deepEqual(
    surfaceIds(applyRailMove(data, { scope: SURFACES, movedId: 123, beforeId: 121 })),
    [123, 121, 122],
  );
  assert.deepEqual(
    surfaceIds(applyRailMove(data, { scope: SURFACES, movedId: 121, beforeId: null })),
    [122, 123, 121],
  );
});

test('a no-op move returns the identical snapshot reference', () => {
  const data = seed();
  // Reference equality is the contract the commit layer uses to skip the network.
  assert.equal(applyRailMove(data, { scope: SURFACES, movedId: 121, beforeId: 122 }), data);
  assert.equal(applyRailMove(data, { scope: SURFACES, movedId: 123, beforeId: null }), data);
  assert.equal(applyRailMove(data, { scope: SURFACES, movedId: 122, beforeId: 122 }), data);
  assert.equal(
    applyRailMove(data, {
      scope: { kind: 'surfaces', worktreeId: 404 },
      movedId: 1,
      beforeId: null,
    }),
    data,
  );
});

test('a move rewrites only its own branch and keeps every other row object', () => {
  const data = seed();
  const moved = applyRailMove(data, { scope: SURFACES, movedId: 123, beforeId: 121 });
  // Unrelated projects are the same objects, not rebuilt copies.
  assert.equal(moved.projects[1], data.projects[1]);
  assert.equal(moved.projects[2], data.projects[2]);
  const before = data.projects[0]?.worktrees[2]?.surfaces[2];
  const after = moved.projects[0]?.worktrees[2]?.surfaces[0];
  assert.equal(after, before);
});

test('rollback restores the captured order from rows still in cache', () => {
  const data = seed();
  const moved = applyRailMove(data, { scope: SURFACES, movedId: 123, beforeId: 121 });
  assert.deepEqual(surfaceIds(restoreRailOrder(moved, SURFACES, [121, 122, 123])), [121, 122, 123]);
});

test('rollback drops vanished siblings and appends ones that appeared', () => {
  const data = workspace([
    project({
      id: 1,
      name: 'isagi',
      worktrees: [
        worktree({ id: 10, projectId: 1, isRoot: true }),
        // 122 was deleted while the write was in flight; 124 was created.
        worktree({
          id: 12,
          projectId: 1,
          surfaces: [surface({ id: 123 }), surface({ id: 121 }), surface({ id: 124 })],
        }),
      ],
    }),
  ]);
  assert.deepEqual(surfaceIds(restoreRailOrder(data, SURFACES, [121, 122, 123])), [121, 123, 124]);
});

test('rollback touches nothing when the list already matches, or its parent is gone', () => {
  const data = seed();
  assert.equal(restoreRailOrder(data, SURFACES, [121, 122, 123]), data);
  assert.equal(restoreRailOrder(data, { kind: 'surfaces', worktreeId: 404 }, [1, 2]), data);
});

test('site existence follows the moved row, not the anchor', () => {
  const data = seed();
  assert.equal(railMoveSiteExists(data, { scope: SURFACES, movedId: 121, beforeId: 999 }), true);
  assert.equal(railMoveSiteExists(data, { scope: SURFACES, movedId: 999, beforeId: 121 }), false);
  // The whole list is gone with its parent worktree.
  assert.equal(
    railMoveSiteExists(data, {
      scope: { kind: 'surfaces', worktreeId: 404 },
      movedId: 121,
      beforeId: null,
    }),
    false,
  );
  // A project that went missing is no longer in the present-project order.
  assert.equal(railMoveSiteExists(data, { scope: PROJECTS, movedId: 3, beforeId: null }), false);
});
