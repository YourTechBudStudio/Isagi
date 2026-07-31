import { Data, Duration, Effect, Schema } from 'effect';

import {
  apiBasePath,
  apiErrorResponseSchema,
  apiEndpoints,
  apiSuccessResponseSchema,
} from '@isagi/contracts';

export const restartReadinessTimeoutMs = 2_000;

export type RestartReadiness =
  | { readonly kind: 'clear' }
  | { readonly kind: 'working_agents'; readonly workingAgentCount: number }
  | { readonly kind: 'unknown' };

export type RestartReadinessDiagnosticCategory = 'timeout' | 'transport' | 'http' | 'decoding';

class RestartReadinessFailure extends Data.TaggedError('RestartReadinessFailure')<{
  readonly category: RestartReadinessDiagnosticCategory;
}> {}

export function createRestartReadinessReader(dependencies: {
  readonly getRuntimeUrl: () => Effect.Effect<string, unknown>;
  readonly fetch?: typeof fetch;
  readonly diagnose: (category: RestartReadinessDiagnosticCategory) => void;
}) {
  const fetchImplementation = dependencies.fetch ?? fetch;
  return () =>
    Effect.suspend(() => {
      // One controller owns the whole HTTP operation — request, body read, and
      // decoding — so the single deadline below cancels a response body that
      // never finishes, not just a request that never produced headers.
      const controller = new AbortController();
      return probeActivity(dependencies, fetchImplementation, controller.signal).pipe(
        Effect.timeoutFail({
          duration: Duration.millis(restartReadinessTimeoutMs),
          onTimeout: () => new RestartReadinessFailure({ category: 'timeout' }),
        }),
        Effect.ensuring(Effect.sync(() => controller.abort())),
        Effect.catchAll((failure) =>
          Effect.sync(() => {
            dependencies.diagnose(
              failure instanceof RestartReadinessFailure ? failure.category : 'transport',
            );
            return { kind: 'unknown' } as const;
          }),
        ),
      );
    });
}

// Every step lives in the tagged failure channel: a degraded runtime can hand
// back an unusable URL, and that has to become a diagnosed `unknown` rather
// than a defect the caller never hears about.
function probeActivity(
  dependencies: {
    readonly getRuntimeUrl: () => Effect.Effect<string, unknown>;
  },
  fetchImplementation: typeof fetch,
  signal: AbortSignal,
) {
  return Effect.gen(function* () {
    const runtimeUrl = yield* dependencies
      .getRuntimeUrl()
      .pipe(Effect.mapError(() => new RestartReadinessFailure({ category: 'transport' })));
    const url = yield* Effect.try({
      try: () =>
        new URL(`${apiBasePath}${apiEndpoints.agentSessions.activity.path}`, runtimeUrl).toString(),
      catch: () => new RestartReadinessFailure({ category: 'transport' }),
    });
    const response = yield* Effect.tryPromise({
      try: () => fetchImplementation(url, { signal }),
      catch: () => new RestartReadinessFailure({ category: 'transport' }),
    });
    const payload = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () => new RestartReadinessFailure({ category: 'decoding' }),
    });
    if (!response.ok) {
      yield* decode(
        apiErrorResponseSchema(apiEndpoints.agentSessions.activity.errors),
        payload,
        new RestartReadinessFailure({ category: 'decoding' }),
      );
      return yield* new RestartReadinessFailure({ category: 'http' });
    }
    const envelope = yield* decode(
      apiSuccessResponseSchema(apiEndpoints.agentSessions.activity.output),
      payload,
      new RestartReadinessFailure({ category: 'decoding' }),
    );
    return envelope.data.workingAgentCount === 0
      ? ({ kind: 'clear' } as const)
      : ({
          kind: 'working_agents',
          workingAgentCount: envelope.data.workingAgentCount,
        } as const);
  });
}

function decode<S extends Schema.Schema.AnyNoContext>(
  schema: S,
  value: unknown,
  failure: RestartReadinessFailure,
) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value),
    catch: () => failure,
  });
}
