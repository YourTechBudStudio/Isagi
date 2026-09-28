import { Effect, type Schema } from 'effect';

import {
  apiBasePath,
  apiErrorResponseSchema,
  apiInfrastructureErrorSchema,
  type ApiContentEndpoint,
  type ApiContentEndpointError,
} from '@isagi/contracts';

import { RuntimeApiError, RuntimeDecodeError, RuntimeTransportError } from './errors.js';
import { decode, interpolatePath, type RuntimeContentEndpointError } from './requester.js';

export type AnyApiContentEndpoint = ApiContentEndpoint<
  Schema.Schema.AnyNoContext,
  Schema.Schema.AnyNoContext | undefined,
  Schema.Schema.AnyNoContext | undefined
>;

/** The route's own query values, such as a checkpoint file's `path`; undefined values are left out. */
export type ContentQuery = Readonly<Record<string, string | number | boolean | undefined>>;

export function contentEndpointUrl(
  runtimeUrl: string,
  endpoint: AnyApiContentEndpoint,
  params: Record<string, string | number>,
  query?: ContentQuery,
): string {
  const url = new URL(`${apiBasePath}${interpolatePath(endpoint.path, params)}`, runtimeUrl);
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
  return url.toString();
}

/**
 * One content route's response, with its body unread.
 *
 * A raw `fetch` rather than the typed requester, because the success body is not the JSON envelope:
 * the caller decides whether to buffer it (the web's `blob()`) or stream it (the CLI). A failure
 * still is the envelope, so a non-OK response is decoded exactly as the typed requester decodes one
 * and the caller sees the same error shape whichever content route it called.
 */
export function requestContent<Endpoint extends AnyApiContentEndpoint>(
  runtimeUrl: string,
  endpoint: Endpoint,
  params: Record<string, string | number>,
  query?: ContentQuery,
): Effect.Effect<Response, RuntimeContentEndpointError<Endpoint>> {
  const url = contentEndpointUrl(runtimeUrl, endpoint, params, query);
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) => fetch(url, { signal }),
      catch: (cause) =>
        new RuntimeTransportError(`Could not reach runtime endpoint ${endpoint.id}.`, cause),
    });
    if (!response.ok) {
      const payload = yield* Effect.tryPromise({
        try: () => response.json() as Promise<unknown>,
        catch: (cause) => new RuntimeDecodeError(endpoint.id, cause),
      });
      const decoded = yield* decode(
        apiErrorResponseSchema(endpoint.errors),
        payload,
        endpoint.id,
      ).pipe(
        Effect.catchAll(() =>
          decode(apiErrorResponseSchema(apiInfrastructureErrorSchema), payload, endpoint.id),
        ),
      );
      return yield* Effect.fail(
        new RuntimeApiError(decoded.error as ApiContentEndpointError<Endpoint>),
      );
    }
    return response;
  });
}
