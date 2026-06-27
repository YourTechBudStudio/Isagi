import { Effect, Layer } from 'effect';

import { getDiagnosticMarker } from './phase.js';

const pollIntervalMs = 250;
const lagWarningThresholdMs = 1_000;

export const EventLoopWatchdogLive = Layer.scopedDiscard(
  Effect.acquireRelease(
    Effect.sync(() => {
      let expectedAt = Date.now() + pollIntervalMs;
      const timer = setInterval(() => {
        const now = Date.now();
        const lagMs = now - expectedAt;
        expectedAt = now + pollIntervalMs;
        if (lagMs < lagWarningThresholdMs) return;

        const marker = getDiagnosticMarker();
        console.warn('[runtime] Event loop lag detected', {
          lagMs,
          markerPhase: marker?.phase ?? null,
          markerElapsedMs: marker ? now - marker.startedAt : null,
          markerContext: marker?.context ?? null,
        });
      }, pollIntervalMs);
      timer.unref();
      return timer;
    }),
    (timer) => Effect.sync(() => clearInterval(timer)),
  ),
);
