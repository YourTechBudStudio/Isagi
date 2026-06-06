import { Duration, Effect, Schedule, Schema } from 'effect';

import { apiBasePath, apiEndpoints, apiSuccessResponseSchema } from '@isagi/contracts';

export interface WaitOptions {
  attempts?: number;
  intervalMs?: number;
  timeoutMs?: number;
}

const defaultWaitOptions = {
  attempts: 40,
  intervalMs: 250,
  timeoutMs: 1_000,
};

export function waitForRuntimeHealth(runtimeUrl: string, options?: WaitOptions) {
  const healthUrl = new URL(`${apiBasePath}${apiEndpoints.health.path}`, runtimeUrl).toString();
  return waitForApiHealth(healthUrl, options);
}

export function waitForWebServer(webUrl: string, options?: WaitOptions) {
  return waitForHttpOk(webUrl, options);
}

function waitForApiHealth(url: string, options: WaitOptions = {}) {
  return waitForOk(
    url,
    options,
    Effect.gen(function* () {
      const response = yield* fetchWithTimeout(
        url,
        options.timeoutMs ?? defaultWaitOptions.timeoutMs,
      );

      if (!response.ok) {
        return yield* Effect.fail(new Error(`${url} responded with ${response.status}`));
      }

      const rawPayload = yield* Effect.tryPromise({
        try: () => response.json() as Promise<unknown>,
        catch: toError,
      });
      const payload = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(apiSuccessResponseSchema(apiEndpoints.health.output))(
            rawPayload,
          ),
        catch: toError,
      });

      if (payload.data.ok !== true) {
        return yield* Effect.fail(new Error(`${url} did not return a healthy runtime API payload`));
      }
    }),
  );
}

function waitForHttpOk(url: string, options: WaitOptions = {}) {
  return waitForOk(
    url,
    options,
    Effect.gen(function* () {
      const response = yield* fetchWithTimeout(
        url,
        options.timeoutMs ?? defaultWaitOptions.timeoutMs,
      );

      if (!response.ok) {
        return yield* Effect.fail(new Error(`${url} responded with ${response.status}`));
      }
    }),
  );
}

function waitForOk(url: string, options: WaitOptions, check: Effect.Effect<void, Error>) {
  const attempts = options.attempts ?? defaultWaitOptions.attempts;
  const intervalMs = options.intervalMs ?? defaultWaitOptions.intervalMs;

  if (attempts <= 0) {
    return Effect.fail(new Error(`Timed out waiting for ${url}`));
  }

  return check.pipe(
    Effect.retry({
      schedule: Schedule.spaced(Duration.millis(intervalMs)),
      times: attempts - 1,
    }),
    Effect.mapError((error) => new Error(`Timed out waiting for ${url}: ${error.message}`)),
  );
}

function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit) {
  return Effect.tryPromise({
    try: (signal) => fetch(url, { ...init, signal }),
    catch: toError,
  }).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(timeoutMs),
      onTimeout: () => new Error(`${url} request timed out after ${timeoutMs}ms`),
    }),
  );
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
