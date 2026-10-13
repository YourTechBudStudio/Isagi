import { Clock, type Duration, Effect, Layer } from 'effect';

import type {
  FluidcastSessionUnreadable,
  FluidcastStartFailed,
  FluidcastUnavailable,
} from './errors.js';
import type { FluidcastSessionId } from './ids.js';
import {
  FluidcastSessions,
  type FluidcastAvailability,
  type FluidcastExecution,
  type FluidcastStartInput,
} from './sessions.service.js';
import { fakeSessionsLayer } from './tests/support.js';

export type FakeFluidcastCall =
  | { readonly kind: 'start'; readonly input: FluidcastStartInput }
  | { readonly kind: 'stop'; readonly fluidcastSessionId: FluidcastSessionId };

/**
 * A `FluidcastSessions` that builds nothing, for tests of the modules that own its callers. It
 * records every start and stop in call order, and `onStart` can hold or fail a start.
 */
export function makeFakeFluidcastSessions(
  options: {
    readonly availability?: FluidcastAvailability | undefined;
    /** Runs inside `start`, before the session exists: hold it with a `Deferred`, or fail it. */
    readonly onStart?:
      | ((
          input: FluidcastStartInput,
        ) => Effect.Effect<
          void,
          FluidcastUnavailable | FluidcastSessionUnreadable | FluidcastStartFailed
        >)
      | undefined;
    /** Runs inside `stop` before the session ends: hold it with a `Deferred`. */
    readonly onStop?: ((fluidcastSessionId: FluidcastSessionId) => Effect.Effect<void>) | undefined;
    /** The worker's final native ID that `stop` reports; by default the one it started with. */
    readonly finalHarnessSessionId?:
      | ((fluidcastSessionId: FluidcastSessionId, input: FluidcastStartInput) => string | null)
      | undefined;
    /** A shared log the test also writes to, so it can assert order across fakes. */
    readonly log?: string[] | undefined;
  } = {},
) {
  const calls: FakeFluidcastCall[] = [];
  const sessions = new Map<
    FluidcastSessionId,
    { readonly input: FluidcastStartInput; execution: FluidcastExecution }
  >();
  let minted = 0;

  const service = FluidcastSessions.of({
    availability: options.availability ?? 'ready',
    start: (input) =>
      Effect.gen(function* () {
        calls.push({ kind: 'start', input });
        options.log?.push(`fluidcast.start:${input.agentSessionId}`);
        if (options.onStart) yield* options.onStart(input);
        const fluidcastSessionId = `fc-${++minted}` as FluidcastSessionId;
        const since = new Date(yield* Clock.currentTimeMillis).toISOString();
        sessions.set(fluidcastSessionId, {
          input,
          execution: { since, worker: { state: 'live' } },
        });
        return { fluidcastSessionId, since };
      }),
    stop: (fluidcastSessionId) =>
      Effect.gen(function* () {
        calls.push({ kind: 'stop', fluidcastSessionId });
        options.log?.push(`fluidcast.stop:${fluidcastSessionId}`);
        if (options.onStop) yield* options.onStop(fluidcastSessionId);
        const session = sessions.get(fluidcastSessionId);
        if (session === undefined) return { harnessSessionId: null };
        sessions.delete(fluidcastSessionId);
        return {
          harnessSessionId: options.finalHarnessSessionId
            ? options.finalHarnessSessionId(fluidcastSessionId, session.input)
            : session.input.harnessSessionId,
        };
      }),
    current: () => Effect.die('FluidcastSessions.current is not used by this fake'),
    execution: (fluidcastSessionId) => sessions.get(fluidcastSessionId)?.execution,
  });

  return {
    service,
    layer: Layer.succeed(FluidcastSessions, service),
    calls,
    /** Live session IDs, in start order. */
    live: () => [...sessions.keys()],
    /** Ends a session's worker as a fault would; publishing `health` is the test's job. */
    fault: (fluidcastSessionId: FluidcastSessionId, reason: string) => {
      const session = sessions.get(fluidcastSessionId);
      if (session !== undefined)
        session.execution = { since: session.execution.since, worker: { state: 'ended', reason } };
    },
  };
}

export type FakeFluidcastSessions = ReturnType<typeof makeFakeFluidcastSessions>;

/**
 * The real `FluidcastSessions` over a builder that never finishes, so every start runs into the
 * build bound (`buildTimeout`, short in tests) and fails `session_build_failed`.
 */
export function hangingFluidcastSessionsLayer(buildTimeout: Duration.Input) {
  return fakeSessionsLayer({ fakes: [], buildTimeout, builder: () => Effect.never }).layer;
}
