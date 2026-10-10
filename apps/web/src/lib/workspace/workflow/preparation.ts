import { Deferred, Effect, PubSub } from 'effect';

import type { WorkflowRunSummary } from '@isagi/contracts';

import { getWorkflowRun } from '../runtime-data.js';
import { workflowLive } from './live.js';

/** The run's own account of itself, read once: "what happened to the launch I just made". */
export const readWorkflowRunSummary = (runId: number) =>
  Effect.map(getWorkflowRun(runId), (output) => output.run);

/**
 * Succeeds with the run's summary once it has left `preparing`.
 *
 * Launch and a preparation Retry both return as soon as the run exists; the worktree, its setup
 * hooks and the surface are prepared in the background. The palette reports what preparation did,
 * so it waits here for the pushed summary. It also reads once up front (preparation may already be
 * over) and again after a reconnect (a push may have been missed while the socket was down). A
 * failed read fails it, so the palette can say it could not read the run.
 */
export const awaitPreparation = Effect.fn('awaitPreparation')(function* (runId: number) {
  const live = yield* workflowLive;
  // Subscribed before the first read, so a push that lands while it is in flight is not missed.
  const signals = yield* live.subscribe;
  const settled = yield* Deferred.make<WorkflowRunSummary, Error>();
  const check = readWorkflowRunSummary(runId).pipe(
    Effect.matchEffect({
      onFailure: (error) => Deferred.fail(settled, error),
      onSuccess: (summary) =>
        summary.status === 'preparing' ? Effect.void : Deferred.succeed(settled, summary),
    }),
    Effect.forkScoped,
  );
  yield* check;
  yield* PubSub.take(signals).pipe(
    Effect.flatMap((signal) => {
      if (
        signal.type === 'run_changed' &&
        signal.summary.runId === runId &&
        signal.summary.status !== 'preparing'
      ) {
        return Deferred.succeed(settled, signal.summary);
      }
      return signal.type === 'connected' ? check : Effect.void;
    }),
    Effect.forever,
    Effect.forkScoped,
  );
  return yield* Deferred.await(settled);
}, Effect.scoped);
