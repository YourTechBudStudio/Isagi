import { Deferred, Duration, Effect, Exit } from 'effect';
import { Atom } from 'effect/reactivity';

/** How long a returning player waits for its session's hide pauses before subscribing anyway. */
export const pauseSettleBound = Duration.seconds(2);

/**
 * The hide `Pause`s still in flight, per Fluidcast session. A returning player subscribes only after
 * every pause sent for its session before it returned has landed, so a late `Pause` can never stop
 * playback the user started after coming back.
 */
export interface PendingPauses {
  /** Runs `send` uninterruptibly, recording it as one of this session's outstanding pauses until it settles. */
  readonly track: (
    fluidcastSessionId: string,
    send: Effect.Effect<void, unknown>,
  ) => Effect.Effect<void>;
  /** Waits for every pause outstanding for this session when called, at most 2 s in total; logs a Warning on failure or timeout; never fails. */
  readonly settled: (fluidcastSessionId: string) => Effect.Effect<void>;
}

export const makePendingPauses = (
  options: { readonly bound?: Duration.Input } = {},
): PendingPauses => {
  const bound = options.bound ?? pauseSettleBound;
  // Each pause owns its own entry, so one settling never removes another. Pauses are idempotent at
  // the Harness, so their order among themselves does not matter, only relative to a subscription.
  const pending = new Map<string, Set<Deferred.Deferred<void, unknown>>>();

  const track: PendingPauses['track'] = (fluidcastSessionId, send) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const done = yield* Deferred.make<void, unknown>();
        const entries = pending.get(fluidcastSessionId) ?? new Set();
        entries.add(done);
        pending.set(fluidcastSessionId, entries);

        const exit = yield* Effect.exit(send);

        entries.delete(done);
        if (entries.size === 0 && pending.get(fluidcastSessionId) === entries) {
          pending.delete(fluidcastSessionId);
        }
        yield* Deferred.done(done, Exit.asVoid(exit));
      }),
    );

  const settled: PendingPauses['settled'] = (fluidcastSessionId) =>
    Effect.suspend(() => {
      const outstanding = [...(pending.get(fluidcastSessionId) ?? [])];
      if (outstanding.length === 0) return Effect.void;
      return Effect.all(
        outstanding.map((entry) => Effect.exit(Deferred.await(entry))),
        { concurrency: 'unbounded' },
      ).pipe(
        Effect.timeoutOption(bound),
        Effect.flatMap((result) => {
          if (result._tag === 'None') {
            return Effect.logWarning(
              '[fluidcast] hide pause did not settle in time; subscribing anyway',
              { fluidcastSessionId },
            );
          }
          return result.value.some(Exit.isFailure)
            ? Effect.logWarning('[fluidcast] hide pause failed; subscribing anyway', {
                fluidcastSessionId,
              })
            : Effect.void;
        }),
      );
    });

  return { track, settled };
};

/** One per registry: every Fluidcast pane and the presentation hook share it. */
export const fluidcastPendingPausesAtom: Atom.Atom<PendingPauses> = Atom.make(() =>
  makePendingPauses(),
).pipe(Atom.keepAlive);
