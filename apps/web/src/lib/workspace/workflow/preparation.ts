import type { WorkflowRunSummary } from '@isagi/contracts';

import { subscribeToWorkflowSignals } from './signals.js';

/**
 * Resolves with the run's summary once it has left `preparing`.
 *
 * Launch and a preparation Retry both return as soon as the run exists; the worktree, its setup
 * hooks and the surface are prepared in the background. The palette reports what preparation did,
 * so it waits here for the pushed summary. It also reads once up front (preparation may already be
 * over) and again after a reconnect (a push may have been missed while the socket was down).
 */
export function awaitPreparation(
  runId: number,
  read: (runId: number) => Promise<WorkflowRunSummary>,
): Promise<WorkflowRunSummary> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      settle();
    };
    const check = () =>
      read(runId).then(
        (summary) => {
          if (summary.status !== 'preparing') finish(() => resolve(summary));
        },
        (error: unknown) => finish(() => reject(error)),
      );
    const unsubscribe = subscribeToWorkflowSignals((signal) => {
      if (
        signal.type === 'run_changed' &&
        signal.summary.runId === runId &&
        signal.summary.status !== 'preparing'
      ) {
        const summary = signal.summary;
        finish(() => resolve(summary));
      } else if (signal.type === 'connected') {
        void check();
      }
    });
    void check();
  });
}
