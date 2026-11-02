import { Data, Duration, Effect, type Redacted } from 'effect';
import { HttpClient } from 'effect/http';

import { apiBasePath, apiEndpoints } from '@isagi/contracts';
import { RuntimeClient, type RuntimeClientError, withRuntimeToken } from '@isagi/runtime-client';

import type { RuntimeLifecycleFailure } from '../runtime-process/index.js';

export const restartReadinessTimeout = Duration.seconds(2);

/** Where the managed runtime listens, and the launcher token it admits for this app run. */
export interface RuntimeAccess {
  readonly url: string;
  readonly launcherToken: Redacted.Redacted<string>;
}

export type RestartReadiness =
  | { readonly kind: 'clear' }
  | { readonly kind: 'working_agents'; readonly workingAgentCount: number }
  | { readonly kind: 'unknown' };

export type RestartReadinessDiagnosticCategory = 'timeout' | 'transport' | 'http' | 'decoding';

class RestartReadinessFailure extends Data.TaggedError('RestartReadinessFailure')<{
  readonly category: RestartReadinessDiagnosticCategory;
}> {}

/**
 * Asks the runtime whether any agent is working, so a restart does not cut one off unannounced.
 *
 * Any failure is an `unknown` answer, never a failed read: the user still gets to decide, and the
 * category goes to `diagnose`. One deadline covers the whole operation — URL, request, body read
 * and decoding — and interrupting the request aborts the fetch, so a body that never finishes does
 * not outlive the deadline either.
 */
export const readRestartReadiness = Effect.fn('DesktopUpdater.readRestartReadiness')(function* (
  runtimeAccess: Effect.Effect<RuntimeAccess, RuntimeLifecycleFailure>,
  diagnose: (category: RestartReadinessDiagnosticCategory) => Effect.Effect<void>,
): Effect.fn.Return<RestartReadiness, never, HttpClient.HttpClient> {
  return yield* probeActivity(runtimeAccess).pipe(
    Effect.timeoutOrElse({
      duration: restartReadinessTimeout,
      orElse: () => Effect.fail(new RestartReadinessFailure({ category: 'timeout' })),
    }),
    Effect.catchTag('RestartReadinessFailure', (failure) =>
      diagnose(failure.category).pipe(Effect.as({ kind: 'unknown' } as const)),
    ),
  );
});

// Every step lives in the tagged failure channel: a degraded runtime can hand back an unusable URL,
// and that has to become a diagnosed `unknown` rather than a defect the caller never hears about.
const probeActivity = Effect.fnUntraced(function* (
  runtimeAccess: Effect.Effect<RuntimeAccess, RuntimeLifecycleFailure>,
) {
  const { url, launcherToken } = yield* runtimeAccess.pipe(
    Effect.mapError(() => new RestartReadinessFailure({ category: 'transport' })),
  );
  // The requester builds its URL with `new URL`, which throws on a malformed base; check the same
  // construction first so that stays a transport failure.
  yield* Effect.try({
    try: () => new URL(apiBasePath, url),
    catch: () => new RestartReadinessFailure({ category: 'transport' }),
  });
  // The one guarded call main makes: only this client carries the launcher token. The shared client stays tokenless,
  // because it also reaches the development web server.
  const client = yield* RuntimeClient.make(url).pipe(
    Effect.updateService(HttpClient.HttpClient, withRuntimeToken(launcherToken)),
  );
  const activity = yield* client
    .request(apiEndpoints.agentSessions.activity)
    .pipe(Effect.mapError((error) => new RestartReadinessFailure({ category: categoryOf(error) })));
  return activity.workingAgentCount === 0
    ? ({ kind: 'clear' } as const)
    : ({ kind: 'working_agents', workingAgentCount: activity.workingAgentCount } as const);
});

function categoryOf(error: RuntimeClientError): RestartReadinessDiagnosticCategory {
  switch (error._tag) {
    case 'RuntimeTransportError':
      return 'transport';
    case 'RuntimeApiError':
      return 'http';
    case 'RuntimeDecodeError':
      return 'decoding';
  }
}
