import { Clock, Context, Duration, Effect, Layer } from 'effect';

import { getDiagnosticMarker } from './phase.js';

/** How often the watchdog samples the event loop, and how late a sample must be to warn. Tests shorten both. */
export const EventLoopWatchdogSettings = Context.Reference<{
  readonly interval: Duration.Duration;
  readonly lagThreshold: Duration.Duration;
}>('isagi/runtime/platform/diagnostics/EventLoopWatchdogSettings', {
  defaultValue: () => ({ interval: Duration.millis(250), lagThreshold: Duration.seconds(1) }),
});

/**
 * Sleeps one interval, then warns when the loop woke up at least `lagThreshold` late, naming the diagnostic phase
 * that was active (`diagnosticPhase`). Measures with the clock it runs under; the layer pins that to the live clock.
 */
const watch = Effect.gen(function* () {
  const { interval, lagThreshold } = yield* EventLoopWatchdogSettings;
  const intervalMs = Duration.toMillis(interval);
  const thresholdMs = Duration.toMillis(lagThreshold);
  const sample = Effect.fnUntraced(function* () {
    const expectedAt = (yield* Clock.currentTimeMillis) + intervalMs;
    yield* Effect.sleep(interval);
    const now = yield* Clock.currentTimeMillis;
    const lagMs = now - expectedAt;
    if (lagMs < thresholdMs) return;

    const marker = getDiagnosticMarker();
    yield* Effect.logWarning('Event loop lag detected').pipe(
      Effect.annotateLogs({
        lagMs,
        markerPhase: marker?.phase ?? null,
        markerElapsedMs: marker ? now - marker.startedAt : null,
        markerContext: marker?.context ?? null,
      }),
    );
  });
  return yield* Effect.forever(sample());
});

/**
 * Background work with no service: warns when the event loop lags. The composition root starts
 * `EventLoopWatchdog.layer`; closing its scope stops the loop.
 *
 * Always on (not gated by `ISAGI_RUNTIME_DEBUG`), and always on the live clock: lag is a fact about real time, so a
 * `TestClock` provided around the runtime in a test must neither stall the watchdog nor fake its readings.
 */
export const EventLoopWatchdog = {
  layer: Layer.effectDiscard(
    watch.pipe(
      Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
      Effect.annotateLogs({ component: 'event-loop-watchdog' }),
      Effect.forkScoped,
    ),
  ),
} as const;
