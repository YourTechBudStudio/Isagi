import { Cause, Deferred, Effect, Exit, FiberSet, type Scope } from 'effect';

import { describeOperationalCause } from '../../platform/diagnostics/index.js';
import { PtyProcessSettings } from '../settings.js';

/**
 * The owner of deferred terminal writes. A kill or exit whose durable fact could not be persisted is handed here and
 * retried until it lands. Persistence retries outlive the call that submitted them, so they live in this owner's
 * scope: the PTY service acquires it first, which makes it the last thing released — while the repository is still
 * open.
 */
export interface PtyPersistenceRetry {
  /**
   * Retries `attempt` every `PtyProcessSettings.persistenceRetryDelay` until it succeeds. Each failure is logged. When
   * the scope closes, a waiting retry gets one immediate final attempt (the delay was only backoff), and a retry that
   * still fails then is abandoned with a warning. Submitting after the scope began closing abandons at once.
   */
  readonly submit: <E>(label: string, attempt: Effect.Effect<void, E>) => Effect.Effect<void>;
}

export const makePersistenceRetry: Effect.Effect<PtyPersistenceRetry, never, Scope.Scope> =
  Effect.gen(function* () {
    const { persistenceRetryDelay } = yield* PtyProcessSettings;
    const fibers = yield* FiberSet.make<void, never>();
    const draining = yield* Deferred.make<void>();
    // Registered after `FiberSet.make`, so it runs before the set interrupts its fibers: shutdown cuts every waiting
    // backoff short and waits for the final attempts instead of dropping them.
    yield* Effect.addFinalizer(() =>
      Deferred.succeed(draining, undefined).pipe(Effect.andThen(FiberSet.awaitEmpty(fibers))),
    );

    const abandon = (label: string) =>
      Effect.logWarning('Abandoning PTY persistence retry after shutdown').pipe(
        Effect.annotateLogs({ label }),
      );

    const loop = Effect.fnUntraced(function* <E>(label: string, attempt: Effect.Effect<void, E>) {
      while (true) {
        yield* Effect.raceFirst(Effect.sleep(persistenceRetryDelay), Deferred.await(draining));
        const exit = yield* Effect.exit(attempt);
        if (Exit.isSuccess(exit)) return;
        yield* Effect.logWarning('PTY persistence retry failed').pipe(
          Effect.annotateLogs({ label, cause: describeOperationalCause(Cause.squash(exit.cause)) }),
        );
        if (yield* Deferred.isDone(draining)) return yield* abandon(label);
      }
    });

    return {
      submit: (label, attempt) =>
        Deferred.isDone(draining).pipe(
          Effect.flatMap((done) =>
            done ? abandon(label) : FiberSet.run(fibers, loop(label, attempt)).pipe(Effect.asVoid),
          ),
        ),
    } satisfies PtyPersistenceRetry;
  });
