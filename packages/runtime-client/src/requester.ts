import { Effect, Schema } from 'effect';

import {
  apiBasePath,
  apiErrorResponseSchema,
  apiInfrastructureErrorSchema,
  apiSuccessResponseSchema,
  type ApiContentEndpointError,
  type ApiEndpoint,
  type ApiEndpointError,
  type ApiEndpointOutput,
  type ApiEndpointParams,
  type ApiEndpointRequestArgs,
  type ApiInfrastructureError,
} from '@isagi/contracts';

import { RuntimeApiError, RuntimeDecodeError, RuntimeTransportError } from './errors.js';

export type RuntimeEndpointError<Endpoint> =
  | RuntimeApiError<ApiEndpointError<Endpoint> | ApiInfrastructureError>
  | RuntimeDecodeError
  | RuntimeTransportError;

/**
 * The same three failures for a content route.
 *
 * A separate alias because `ApiEndpointError` infers from `ApiEndpoint`, which a content endpoint
 * deliberately is not — it has no output schema. Inferring against it would silently collapse the
 * declared error union to `never` and leave only the infrastructure arm.
 */
export type RuntimeContentEndpointError<Endpoint> =
  | RuntimeApiError<ApiContentEndpointError<Endpoint> | ApiInfrastructureError>
  | RuntimeDecodeError
  | RuntimeTransportError;

export type AnyApiEndpoint = ApiEndpoint<
  Schema.Schema.AnyNoContext | undefined,
  Schema.Schema.AnyNoContext,
  Schema.Schema.AnyNoContext,
  Schema.Schema.AnyNoContext | undefined,
  Schema.Schema.AnyNoContext | undefined
>;

export type EndpointRequester = <Endpoint extends AnyApiEndpoint>(
  endpoint: Endpoint,
  ...args: ApiEndpointRequestArgs<Endpoint>
) => Effect.Effect<ApiEndpointOutput<Endpoint>, RuntimeEndpointError<Endpoint>>;

export function createEndpointRequester(runtimeUrl: string): EndpointRequester {
  return function requestEndpoint<Endpoint extends AnyApiEndpoint>(
    endpoint: Endpoint,
    ...args: ApiEndpointRequestArgs<Endpoint>
  ): Effect.Effect<ApiEndpointOutput<Endpoint>, RuntimeEndpointError<Endpoint>> {
    return Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: (signal) => {
          const init: RequestInit = { method: endpoint.method, signal };
          const params = endpoint.params ? (args[0] as ApiEndpointParams<Endpoint>) : undefined;
          const query = endpoint.query ? args[endpoint.params ? 1 : 0] : undefined;
          const body = endpoint.body
            ? args[(endpoint.params ? 1 : 0) + (endpoint.query ? 1 : 0)]
            : undefined;
          if (endpoint.body) {
            init.headers = { 'Content-Type': 'application/json' };
            init.body = JSON.stringify(body);
          }
          const url = new URL(
            `${apiBasePath}${interpolatePath(endpoint.path, params)}`,
            runtimeUrl,
          );
          appendQuery(url, query);
          return fetch(url, init);
        },
        catch: (cause) =>
          new RuntimeTransportError(`Could not reach runtime endpoint ${endpoint.id}.`, cause),
      });

      const payload = yield* Effect.tryPromise({
        try: () => response.json() as Promise<unknown>,
        catch: (cause) => new RuntimeDecodeError(endpoint.id, cause),
      });

      if (!response.ok) {
        const decoded = yield* decode(
          apiErrorResponseSchema(endpoint.errors),
          payload,
          endpoint.id,
        ).pipe(
          Effect.catchAll(() =>
            decode(apiErrorResponseSchema(apiInfrastructureErrorSchema), payload, endpoint.id),
          ),
        );
        return yield* Effect.fail(new RuntimeApiError(decoded.error));
      }

      const decoded = yield* decode(
        apiSuccessResponseSchema(endpoint.output),
        payload,
        endpoint.id,
      );
      return decoded.data as ApiEndpointOutput<Endpoint>;
    });
  };
}

export function appendQuery(url: URL, query: unknown) {
  if (!query || typeof query !== 'object') {
    return;
  }

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    // A repeated parameter is repeated on the wire, not comma-joined: that is the shape HTTP
    // already has, and joining would make the separator illegal inside a value forever.
    if (Array.isArray(value)) {
      for (const entry of value as readonly unknown[]) {
        url.searchParams.append(key, String(entry));
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
}

export function interpolatePath(path: string, params: unknown) {
  if (!params || typeof params !== 'object') {
    return path;
  }

  return Object.entries(params).reduce(
    (nextPath, [key, value]) => nextPath.replace(`:${key}`, encodeURIComponent(String(value))),
    path,
  );
}

export function decode<Decoded, Encoded>(
  schema: Schema.Schema<Decoded, Encoded, never>,
  value: unknown,
  endpointId: string,
) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value),
    catch: (cause) => new RuntimeDecodeError(endpointId, cause),
  });
}
