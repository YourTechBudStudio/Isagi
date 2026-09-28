import { stat } from 'node:fs/promises';

import { Effect } from 'effect';

/**
 * Pairs a transcript locator with whether it resolves to something right now.
 *
 * The `stat` is the whole point. A native transcript is a best-effort external source (ADR 0007):
 * the runtime neither writes it nor owns its retention, so a locator alone would be a reference
 * that looks live whether or not the provider ever wrote it or has since rotated it away. Checking
 * at read time — rather than storing a flag — keeps the answer true for the moment it is given,
 * which is the only moment a postmortem reader can act on.
 *
 * Any failure to `stat` reads as unavailable, including a permission error: from the reader's
 * position "I cannot get at it" and "it is not there" call for the same next step.
 */
export function transcriptAt(
  locator: string,
): Effect.Effect<{ readonly locator: string; readonly available: boolean }> {
  return Effect.promise(() =>
    stat(locator).then(
      () => ({ locator, available: true }),
      () => ({ locator, available: false }),
    ),
  );
}
