import { Context, Effect, Layer, Queue } from 'effect';

import type { RuntimeDatabaseService } from '../../persistence/index.js';

/**
 * "A workflow write transaction finished." Nothing more.
 *
 * The delta publisher needs to know when to look, and this is the only thing it is ever told: not
 * what changed, not which revisions, not whether the transaction committed. The database stays the
 * authority — the publisher drains committed transitions and a wake after a rollback simply finds
 * nothing. That is deliberate, because a notification that carried facts could disagree with what
 * actually committed, and this one has nothing to be wrong about.
 *
 * It is a sliding queue of one: several writes while a drain is in flight collapse into one more
 * drain, which is all they ever mean.
 */
export interface WorkflowWriteWakeService {
  /** Called after every workflow write transaction, on both the success and the failure path. */
  readonly signal: Effect.Effect<void>;
  /** Parks until the next write. */
  readonly awaitSignal: Effect.Effect<void>;
}

export const WorkflowWriteWake =
  Context.GenericTag<WorkflowWriteWakeService>('isagi/WorkflowWriteWake');

export const WorkflowWriteWakeLive = Layer.scoped(
  WorkflowWriteWake,
  Effect.gen(function* () {
    const queue = yield* Queue.sliding<void>(1);
    yield* Effect.addFinalizer(() => queue.shutdown);
    return {
      signal: queue.offer(void 0).pipe(Effect.asVoid),
      awaitSignal: queue.take.pipe(Effect.asVoid),
    } satisfies WorkflowWriteWakeService;
  }),
);

/** A wake nobody is listening for, which is what a persistence test wants. */
export const silentWriteWake: WorkflowWriteWakeService = {
  signal: Effect.void,
  awaitSignal: Effect.never,
};

/**
 * Wraps a database handle so every transaction taken through it wakes the publisher.
 *
 * Applied once at each repository's construction rather than at its ~25 write sites: a write that
 * forgot to wake would be a delta nobody delivered, and this makes forgetting impossible for any
 * write that goes through the repository at all.
 */
export function wakingDatabase(
  database: Pick<RuntimeDatabaseService, 'use' | 'transaction'>,
  wake: WorkflowWriteWakeService,
): Pick<RuntimeDatabaseService, 'use' | 'transaction'> {
  return {
    use: database.use,
    transaction: (operation, run) =>
      database.transaction(operation, run).pipe(Effect.ensuring(wake.signal)),
  };
}
