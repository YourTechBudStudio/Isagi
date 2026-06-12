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

export function formatWorktreeSetupFailureDetails(
  setup: Extract<WorktreeSetupFailure['setup'], { status: 'failed' }>,
) {
  return [
    setup.message,
    setup.command ? `command: ${setup.command}` : null,
    setup.src ? `src: ${setup.src}` : null,
    setup.dest ? `dest: ${setup.dest}` : null,
    setup.exitCode !== undefined && setup.exitCode !== null ? `exit code: ${setup.exitCode}` : null,
    setup.signal ? `signal: ${setup.signal}` : null,
    setup.stderrExcerpt ? `\nstderr:\n${setup.stderrExcerpt}` : null,
    setup.stdoutExcerpt ? `\nstdout:\n${setup.stdoutExcerpt}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}
