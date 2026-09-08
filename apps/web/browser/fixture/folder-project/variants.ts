import { create } from 'zustand';

import type { RecheckOutcome } from './fake-runtime.js';

/**
 * What is left of the fixture's controls once every design question is closed.
 *
 * Nothing here is a treatment any more. The subtitle, the folder environment's
 * title, the verdict's shape and the restore's feedback were each switchable
 * while they were open and are each hardcoded now — a switch that outlives its
 * question becomes a second definition of the design, waiting to disagree with
 * the first.
 *
 * The `today's treatment` comparison went with them in phase 07, for a different
 * reason: it rendered the old decoration inside the fixture's own rail and strip,
 * and those forks are gone. The production components are mounted here now, so
 * there is no longer a "before" for this page to draw — what it shows *is* the
 * app. What remains is how the recovery surface is driven.
 */
export interface VariantState {
  /** What the next recheck will do. */
  readonly outcome: RecheckOutcome;
  /** How long both of its stages take, so the pending state can be looked at. */
  readonly latency: number;
  readonly set: (patch: Partial<Omit<VariantState, 'set'>>) => void;
}

export const useVariants = create<VariantState>((set) => ({
  outcome: 'restores',
  latency: 0,
  set: (patch) => set(patch),
}));
