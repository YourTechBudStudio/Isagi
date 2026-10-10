// Waiting for a server the desktop just started (the runtime) or depends on in development (the web dev server).
// Both poll: one attempt per 250 ms, each bounded by 1 s, 40 attempts in total.
import { Data, Duration, Effect, Schedule } from 'effect';
import { HttpClient, HttpClientResponse, type HttpClientError } from 'effect/http';

import { apiBasePath, apiEndpoints } from '@isagi/contracts';
import { RuntimeClient, type RuntimeEndpointError } from '@isagi/runtime-client';

const attempts = 40;
const attemptInterval = Duration.millis(250);
const attemptTimeout = Duration.seconds(1);

/** The server never answered usefully. `lastFailure` describes the final attempt. */
export class ServerWaitFailed extends Data.TaggedError('ServerWaitFailed')<{
  readonly url: string;
  readonly lastFailure: string;
}> {
  override get message() {
    return `Timed out waiting for ${this.url}: ${this.lastFailure}`;
  }
}

/**
 * The runtime URL cannot serve as a base for the health endpoint (a scheme-less `localhost:4100`, say). The message is
 * the parser's own (`Invalid URL`), which never echoes the value: an external runtime URL can carry credentials.
 */
export class InvalidRuntimeUrl extends Data.TaggedError('InvalidRuntimeUrl')<{
  readonly cause: unknown;
}> {
  override get message() {
    return errorMessage(this.cause);
  }
}

/**
 * Succeeds once the runtime at `runtimeUrl` answers its health endpoint with the contract's healthy payload. A
 * `runtimeUrl` that is not a valid base URL fails at once (it is a failure, not a defect, so the caller can report it).
 */
export const waitForRuntimeHealth = Effect.fn('desktop.waitForRuntimeHealth')(function* (
  runtimeUrl: string,
) {
  const healthUrl = yield* Effect.try({
    try: () => new URL(`${apiBasePath}${apiEndpoints.health.path}`, runtimeUrl).toString(),
    catch: (cause) => new InvalidRuntimeUrl({ cause }),
  });
  const client = yield* RuntimeClient.make(runtimeUrl);
  // The contract's `ok: true` literal makes a decoded payload a healthy one.
  const attempt = client.request(apiEndpoints.health).pipe(
    Effect.mapError(
      (error) =>
        new ServerWaitFailed({
          url: healthUrl,
          lastFailure: describeRuntimeFailure(healthUrl, error),
        }),
    ),
  );
  return yield* poll(healthUrl, Effect.asVoid(attempt));
});

/** Succeeds once `webUrl` answers with a 2xx status (development only). */
export const waitForWebServer = Effect.fn('desktop.waitForWebServer')(function* (webUrl: string) {
  const attempt = HttpClient.get(webUrl).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    // No `traceparent`/`b3` headers: the request is the same bare GET the dev server always saw.
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.mapError(
      (error) =>
        new ServerWaitFailed({ url: webUrl, lastFailure: describeHttpFailure(webUrl, error) }),
    ),
  );
  return yield* poll(webUrl, Effect.asVoid(attempt));
});

function poll<R>(url: string, attempt: Effect.Effect<void, ServerWaitFailed, R>) {
  return attempt.pipe(
    Effect.timeoutOrElse({
      duration: attemptTimeout,
      orElse: () =>
        Effect.fail(
          new ServerWaitFailed({
            url,
            lastFailure: `${url} request timed out after ${Duration.toMillis(attemptTimeout)}ms`,
          }),
        ),
    }),
    Effect.retry({ schedule: Schedule.spaced(attemptInterval), times: attempts - 1 }),
  );
}

function describeRuntimeFailure(
  url: string,
  error: RuntimeEndpointError<typeof apiEndpoints.health>,
): string {
  switch (error._tag) {
    case 'RuntimeApiError':
      return `${url} responded with ${error.apiError.status}`;
    case 'RuntimeTransportError':
    case 'RuntimeDecodeError':
      return errorMessage(error.cause);
  }
}

function describeHttpFailure(url: string, error: HttpClientError.HttpClientError): string {
  const response = error.response;
  if (response) return `${url} responded with ${response.status}`;
  return 'cause' in error.reason && error.reason.cause !== undefined
    ? errorMessage(error.reason.cause)
    : error.message;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
