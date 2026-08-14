import type { WorkspaceData } from './model.js';
import type { Project, Worktree } from './types.js';

/**
 * Pure projection of a rail reorder onto the cached workspace snapshot.
 *
 * The runtime owns durable order and expresses it through array position, so
 * everything here is array surgery: no ranks, no network, no React, no Effect.
 * Keeping it separate from the commit workflow is what lets every scope, edge,
 * and rollback shape be tested without a query client or a fetch mock.
 *
 * Two conventions are worth knowing before reading on:
 *
 * - Reordering is expressed over **identifier sequences**, matching the runtime's
 *   own `moveBefore(orderedIds, …)` helper. The concrete rows are then re-sorted
 *   into that sequence, so item objects are never rebuilt — only repositioned.
 * - Every function that rewrites a list returns the **same `WorkspaceData`
 *   reference** when it changed nothing. That makes `applyRailMove(data, intent)
 *   === data` the definition of "this drop was a no-op", so the commit layer
 *   needs no separate comparison.
 */

/**
 * A reorderable sibling list. Modelled as a tagged union rather than a string so
 * the parent identifier is carried in the type and the endpoint can be chosen by
 * an exhaustive switch. `scopeKey` derives the flat string the DOM and the
 * pending-state map use; nothing parses that string back.
 */
export type RailOrderScope =
  | { readonly kind: 'projects' }
  | { readonly kind: 'worktrees'; readonly projectId: number }
  | { readonly kind: 'surfaces'; readonly worktreeId: number };

/** One bounded move against an explicit sibling anchor. `null` appends. */
export interface RailMoveIntent {
  readonly scope: RailOrderScope;
  readonly movedId: number;
  readonly beforeId: number | null;
}

/**
 * The flat key for a scope, matching the `data-drag-scope` spellings the drag
 * engine already uses so the interaction layer and the data layer address the
 * same list by the same name.
 */
export function scopeKey(scope: RailOrderScope): string {
  switch (scope.kind) {
    case 'projects':
      return 'projects';
    case 'worktrees':
      return `worktrees:${scope.projectId}`;
    case 'surfaces':
      return `surfaces:${scope.worktreeId}`;
  }
}

/**
 * Move `movedId` so it sits immediately before `beforeId`, or last when
 * `beforeId` is null. Order-preserving for every other member, and total: an
 * unknown moved item or anchor yields the input sequence unchanged, which is how
 * a drop against siblings that vanished mid-gesture degrades to a no-op instead
 * of inventing a position.
 */
export function moveBefore(
  ids: readonly number[],
  movedId: number,
  beforeId: number | null,
): readonly number[] {
  if (!ids.includes(movedId)) return ids;
  const rest = ids.filter((id) => id !== movedId);
  if (beforeId === null) return [...rest, movedId];
  const index = rest.indexOf(beforeId);
  if (index === -1) return ids;
  return [...rest.slice(0, index), movedId, ...rest.slice(index)];
}

/**
 * The ordered identifiers of a scope's reorderable siblings, or `null` when the
 * scope itself is not in the snapshot.
 *
 * `null` and `[]` are deliberately different answers: a project holding only its
 * root worktree is a legal scope with no reorderable members, while a project
 * deleted underneath the drag has no scope at all. Rollback and failure
 * placement both branch on that distinction.
 */
export function railSiblingIds(
  data: WorkspaceData,
  scope: RailOrderScope,
): readonly number[] | null {
  const list = readScope(data, scope);
  return list ? list.map((item) => item.id) : null;
}

/** Apply a move to the snapshot, or return it untouched when nothing changes. */
export function applyRailMove(data: WorkspaceData, intent: RailMoveIntent): WorkspaceData {
  return rewriteScope(data, intent.scope, (ids) =>
    moveBefore(ids, intent.movedId, intent.beforeId),
  );
}

/**
 * Put one sibling list back the way it was before an optimistic move, using the
 * captured identifier sequence rather than a retained copy of the old snapshot.
 *
 * Only this list is touched. Identifiers that disappeared while the write was in
 * flight are dropped, siblings that appeared are appended in their current
 * order, and every surviving row is the object currently in cache — so a
 * concurrent update to an unrelated fact on a rolled-back row survives. The
 * caller invalidates afterwards, so this only has to be honest, not final.
 */
export function restoreRailOrder(
  data: WorkspaceData,
  scope: RailOrderScope,
  capturedIds: readonly number[],
): WorkspaceData {
  const captured = new Set(capturedIds);
  return rewriteScope(data, scope, (ids) => [
    ...capturedIds.filter((id) => ids.includes(id)),
    ...ids.filter((id) => !captured.has(id)),
  ]);
}

/**
 * Whether the row the user actually dragged is still somewhere a failure can be
 * shown. False when the moved item is gone, or when its whole list is gone
 * because the parent project or worktree disappeared. This is the data-side test
 * for "the initiating site survived"; the commit layer never inspects the DOM.
 */
export function railMoveSiteExists(data: WorkspaceData, intent: RailMoveIntent): boolean {
  const ids = railSiblingIds(data, intent.scope);
  return ids !== null && ids.includes(intent.movedId);
}

/**
 * Read a scope's reorderable members, or `null` when the scope is absent.
 *
 * Two exclusions here are the ordering contract, not conveniences. Disconnected
 * projects are not part of the present-project order (Phase 02 sections the
 * snapshot present-first), and a project's root worktree is pinned first and is
 * never a legal source or anchor — so neither ever appears in a list a drop can
 * rearrange. A project with no derived root is legal; then every worktree is
 * reorderable.
 */
function readScope(
  data: WorkspaceData,
  scope: RailOrderScope,
): readonly { readonly id: number }[] | null {
  switch (scope.kind) {
    case 'projects':
      return data.projects.filter(isPresent);
    case 'worktrees': {
      const project = data.projects.find((candidate) => candidate.id === scope.projectId);
      return project ? project.worktrees.filter((worktree) => !worktree.isRoot) : null;
    }
    case 'surfaces': {
      const worktree = findWorktree(data, scope.worktreeId);
      return worktree ? worktree.surfaces : null;
    }
  }
}

/**
 * Rewrite one scope's order and splice the result back into the snapshot,
 * leaving every other branch — and every row object — as it was.
 *
 * Returns the input `data` unchanged when the scope is absent or the resulting
 * identifier sequence is identical, which is what makes reference equality a
 * reliable no-op signal for callers.
 */
function rewriteScope(
  data: WorkspaceData,
  scope: RailOrderScope,
  reorder: (ids: readonly number[]) => readonly number[],
): WorkspaceData {
  switch (scope.kind) {
    case 'projects': {
      const present = data.projects.filter(isPresent);
      const next = sortById(present, reorder(present.map((project) => project.id)));
      if (!next) return data;
      // The present section is rebuilt in place and the Disconnected section
      // follows it untouched, so an append lands at the end of the present
      // projects — never below the disconnected ones, which is an order the
      // runtime would never return.
      return {
        ...data,
        projects: [...next, ...data.projects.filter((project) => !isPresent(project))],
      };
    }
    case 'worktrees': {
      const project = data.projects.find((candidate) => candidate.id === scope.projectId);
      if (!project) return data;
      const rest = project.worktrees.filter((worktree) => !worktree.isRoot);
      const next = sortById(rest, reorder(rest.map((worktree) => worktree.id)));
      if (!next) return data;
      // The root is spliced back at the head, which is how it stays pinned
      // without the reorder ever having to know about it.
      const roots = project.worktrees.filter((worktree) => worktree.isRoot);
      return {
        ...data,
        projects: data.projects.map((candidate) =>
          candidate.id === project.id
            ? { ...candidate, worktrees: [...roots, ...next] }
            : candidate,
        ),
      };
    }
    case 'surfaces': {
      const worktree = findWorktree(data, scope.worktreeId);
      if (!worktree) return data;
      const next = sortById(worktree.surfaces, reorder(worktree.surfaces.map((s) => s.id)));
      if (!next) return data;
      return {
        ...data,
        projects: data.projects.map((project) =>
          project.worktrees.some((candidate) => candidate.id === worktree.id)
            ? {
                ...project,
                worktrees: project.worktrees.map((candidate) =>
                  candidate.id === worktree.id ? { ...candidate, surfaces: next } : candidate,
                ),
              }
            : project,
        ),
      };
    }
  }
}

/**
 * Re-sort `list` into `ids`, or return `null` when `ids` already matches the
 * list's current order — the signal that nothing needs rewriting. Rows whose
 * identifier is missing from `ids` are appended, so a reorder that loses an
 * identifier can never silently drop a row from the rail.
 */
function sortById<Item extends { readonly id: number }>(
  list: readonly Item[],
  ids: readonly number[],
): readonly Item[] | null {
  if (list.length === ids.length && list.every((item, index) => item.id === ids[index])) {
    return null;
  }
  const byId = new Map(list.map((item) => [item.id, item]));
  const ordered = ids.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
  const placed = new Set(ids);
  return [...ordered, ...list.filter((item) => !placed.has(item.id))];
}

function findWorktree(data: WorkspaceData, worktreeId: number): Worktree | undefined {
  for (const project of data.projects) {
    const worktree = project.worktrees.find((candidate) => candidate.id === worktreeId);
    if (worktree) return worktree;
  }
  return undefined;
}

function isPresent(project: Project) {
  return project.status === 'present';
}
