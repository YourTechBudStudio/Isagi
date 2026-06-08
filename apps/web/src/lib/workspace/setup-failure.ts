import { create } from 'zustand';

import type { OpenWorktreeOutput } from '@isagi/contracts';

export type WorktreeSetupFailure = Extract<OpenWorktreeOutput, { status: 'created_setup_failed' }>;

interface WorktreeSetupFailureStore {
  readonly failure: WorktreeSetupFailure | null;
  readonly showFailure: (failure: WorktreeSetupFailure) => void;
  readonly clearFailure: () => void;
}

export const useWorktreeSetupFailureStore = create<WorktreeSetupFailureStore>((set) => ({
  failure: null,
  showFailure: (failure) => set({ failure }),
  clearFailure: () => set({ failure: null }),
}));

export function showWorktreeSetupFailure(failure: WorktreeSetupFailure) {
  useWorktreeSetupFailureStore.getState().showFailure(failure);
}
