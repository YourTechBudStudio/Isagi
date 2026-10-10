import { Cause, Effect, type Duration, type Scope } from 'effect';

/**
 * The one rule for periodic runtime work (PTY status polling, PTY GC, session GC, content GC): run `tick` every
 * `every` for as long as the caller's scope stays open.
 *
 * - The first tick runs one interval in, like `setInterval`.
 * - Ticks never overlap: the next interval starts after the previous tick ends, so a slow tick delays the next one
 *   instead of running beside it.
 * - A failing or dying tick is logged at `Warning` with its cause, annotated `loop=<name>`, and the loop continues.
 *   Callers do not wrap their tick in their own catch-all.
 * - A tick that interrupts itself (for example by waiting on a queue that was shut down) stops the loop with a
 *   `Warning`, instead of being retried forever.
 * - The loop is a fiber forked into the caller's scope: closing the scope (layer release, test scope) interrupts it,
 *   including in the middle of a tick.
 *
 * Time comes from the Effect `Clock`, so tests drive the loop with `TestClock.adjust`.
 */
export const runPeriodically = <A, E, R>(
  name: string,
  every: Duration.Input,
  tick: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, R | Scope.Scope> =>
  Effect.sleep(every).pipe(
    Effect.andThen(tick),
    Effect.asVoid,
    // External interruption of the loop fiber never reaches this handler; only the tick's own failures, defects and
    // self-interruptions do.
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.logWarning(`${name} stopped: its tick was interrupted`).pipe(
            Effect.andThen(Effect.interrupt),
          )
        : Effect.logWarning(`${name} failed`, cause),
    ),
    Effect.forever,
    Effect.annotateLogs({ loop: name }),
    Effect.forkScoped,
    Effect.asVoid,
  );
