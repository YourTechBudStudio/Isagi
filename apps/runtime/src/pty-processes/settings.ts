import { Context, Duration } from 'effect';

/**
 * The PTY service's timings. Production uses the defaults; tests provide shorter or TestClock-driven values with
 * `Layer.succeed(PtyProcessSettings, {...})`.
 */
export interface PtyProcessTimings {
  /** How often live rows are reconciled against their backends. Also the age after which a reservation is reported. */
  readonly statusPollInterval: Duration.Duration;
  /** How often PTY garbage collection runs after the startup pass. */
  readonly garbageCollectionInterval: Duration.Duration;
  /** Backoff between attempts of a terminal write that could not be persisted. */
  readonly persistenceRetryDelay: Duration.Duration;
}

export const PtyProcessSettings = Context.Reference<PtyProcessTimings>(
  'isagi/runtime/pty-processes/PtyProcessSettings',
  {
    defaultValue: () => ({
      statusPollInterval: Duration.seconds(10),
      garbageCollectionInterval: Duration.minutes(5),
      persistenceRetryDelay: Duration.seconds(1),
    }),
  },
);
