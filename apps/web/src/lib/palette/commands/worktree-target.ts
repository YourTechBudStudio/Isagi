import type { ArgValues, PaletteContext } from '../types.js';

/**
 * The worktree a command acts on, resolved once for every command that takes one.
 *
 * Explicit values win: a chrome affordance that names its target (a rail context
 * menu, the action bar) must never have that target quietly replaced by whatever
 * happens to be active. The active worktree is the fallback for palette and
 * keyboard dispatch, which name no target at all.
 */
export function worktreeIdFromValues(values: ArgValues, ctx: PaletteContext): number | null {
  const worktreeId = Number(values.worktreeId);
  if (Number.isInteger(worktreeId)) {
    return worktreeId;
  }
  return ctx.activeWorktree?.id ?? null;
}

/**
 * The empty surface a start command fills instead of creating a new surface.
 *
 * An explicit `intoSurfaceId` wins (the empty-surface actions name their own
 * surface). Otherwise, plain palette or keyboard dispatch — which names no
 * worktree — fills the active surface when it has no panes, so `cmd+k` on an
 * empty surface starts something *there*. A command aimed at an explicit
 * worktree never borrows the active surface.
 */
export function emptySurfaceIdFromValues(values: ArgValues, ctx: PaletteContext): number | null {
  const intoSurfaceId = Number(values.intoSurfaceId);
  if (Number.isInteger(intoSurfaceId)) {
    return intoSurfaceId;
  }
  if (values.worktreeId !== undefined) {
    return null;
  }
  const surface = ctx.activeSurface;
  return surface && surface.paneKinds.length === 0 ? surface.id : null;
}
