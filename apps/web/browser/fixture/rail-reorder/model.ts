import type {
  AccentColor,
  AttentionState,
  PaneSessionKind,
} from '../../../src/lib/workspace/types.js';

/**
 * The fixture's own rail model. Deliberately *not* the production
 * `lib/workspace/types` shape: this phase has no runtime, no snapshot, and no
 * contract, and borrowing the production types here would imply a data binding
 * that does not exist yet. What it does borrow is the vocabulary that decides
 * how a row *looks* — accent, attention, pane kind — so the fixture renders at
 * the real visual fidelity the variant comparison depends on.
 */

export interface FixtureSurface {
  readonly id: number;
  readonly title: string;
  readonly paneKind: PaneSessionKind | null;
  readonly attention: AttentionState;
}

export interface FixtureWorktree {
  readonly id: number;
  readonly title: string;
  readonly path: string;
  readonly branch: string;
  readonly isRoot: boolean;
  readonly parked: boolean;
  readonly attention: AttentionState;
  readonly surfaces: readonly FixtureSurface[];
}

export interface FixtureProject {
  readonly id: number;
  readonly name: string;
  readonly glyph: string;
  readonly accent: AccentColor;
  readonly worktrees: readonly FixtureWorktree[];
}

export interface FixtureMissingProject {
  readonly id: number;
  readonly name: string;
  readonly glyph: string;
}

export interface RailModel {
  readonly projects: readonly FixtureProject[];
  readonly missing: readonly FixtureMissingProject[];
}

/**
 * A reorderable sibling list, addressed by a string key. The key is what the
 * drag engine matches a hovered DOM ancestor against, so it doubles as the
 * legality rule: two items can only trade places when they resolve to the same
 * key. Cross-project worktree moves and cross-worktree surface moves are
 * therefore unrepresentable rather than merely rejected.
 */
export const PROJECT_SCOPE = 'projects';
export const worktreeScope = (projectId: number) => `worktrees:${projectId}`;
export const surfaceScope = (worktreeId: number) => `surfaces:${worktreeId}`;
/** The Disconnected section is a scope so hovering it resolves — to nothing legal. */
export const DISCONNECTED_SCOPE = 'disconnected';

/**
 * Move `movedId` so it sits immediately before `beforeId`, or last when
 * `beforeId` is null. Pure, total, and order-preserving for every other member
 * — the same single-anchor move the runtime mutation will express in Phase 03,
 * so the optimistic projection Phase 04 needs is already this function.
 */
export function moveBefore<T extends { readonly id: number }>(
  list: readonly T[],
  movedId: number,
  beforeId: number | null,
): readonly T[] {
  const moved = list.find((item) => item.id === movedId);
  if (!moved) return list;
  const rest = list.filter((item) => item.id !== movedId);
  if (beforeId === null) return [...rest, moved];
  const index = rest.findIndex((item) => item.id === beforeId);
  if (index === -1) return list;
  return [...rest.slice(0, index), moved, ...rest.slice(index)];
}

/**
 * Apply a move to the whole model by resolving the scope key back to the list
 * that owns it. The root worktree never appears in a reorderable list — it is
 * spliced back in at the head — which is what keeps it pinned without a
 * special case at the drop site.
 */
export function applyMove(
  model: RailModel,
  scope: string,
  movedId: number,
  beforeId: number | null,
): RailModel {
  if (scope === PROJECT_SCOPE) {
    return { ...model, projects: moveBefore(model.projects, movedId, beforeId) };
  }

  return {
    ...model,
    projects: model.projects.map((project) => {
      if (scope === worktreeScope(project.id)) {
        const root = project.worktrees.filter((worktree) => worktree.isRoot);
        const rest = project.worktrees.filter((worktree) => !worktree.isRoot);
        return { ...project, worktrees: [...root, ...moveBefore(rest, movedId, beforeId)] };
      }
      return {
        ...project,
        worktrees: project.worktrees.map((worktree) =>
          scope === surfaceScope(worktree.id)
            ? { ...worktree, surfaces: moveBefore(worktree.surfaces, movedId, beforeId) }
            : worktree,
        ),
      };
    }),
  };
}
