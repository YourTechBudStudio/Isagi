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
