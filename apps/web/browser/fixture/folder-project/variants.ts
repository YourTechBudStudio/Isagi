import { create } from 'zustand';

import type { RecheckOutcome } from './fake-runtime.js';

/**
 * What is left of the fixture's controls once every design question is closed.
 *
 * Nothing here is a treatment any more. The subtitle, the folder environment's
 * title, the verdict's shape and the restore's feedback were each switchable
 * while they were open and are each hardcoded now — a switch that outlives its
 * question becomes a second definition of the design, waiting to disagree with
 * the first. What remains is how the recovery surface is *driven*, plus one
 * comparison against today's app.
 */
export interface VariantState {
  /** What the next recheck will do. */
  readonly outcome: RecheckOutcome;
  /** How long both of its stages take, so the pending state can be looked at. */
  readonly latency: number;
  /**
   * Render the rail and strip exactly as the app does *today* — the Git ref
   * appended to every subtitle including a folder's, and the Open worktree
   * affordance on every project. The "before" for every claim on this page, in
   * place rather than from memory.
   */
  readonly showCurrent: boolean;
  readonly set: (patch: Partial<Omit<VariantState, 'set'>>) => void;
}

export const useVariants = create<VariantState>((set) => ({
  outcome: 'restores',
  latency: 0,
  showCurrent: false,
  set: (patch) => set(patch),
}));
