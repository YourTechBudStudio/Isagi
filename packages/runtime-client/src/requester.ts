import { Effect, Schema, Stream } from 'effect';
import {
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse,
} from 'effect/http';

import {
  apiBasePath,
  apiErrorResponseSchema,
  apiInfrastructureErrorSchema,
  apiSuccessResponseSchema,
  type AnyApiContentEndpoint,
  type AnyApiEndpoint,
  type ApiContentEndpointError,
  type ApiEndpointError,
  type ApiEndpointOutput,
  type ApiEndpointRequestArgs,
  type ApiError,
  type ApiInfrastructureError,
  type WireSchema,
} from '@isagi/contracts';

import { RuntimeApiError, RuntimeDecodeError, RuntimeTransportError } from './errors.js';

/**
 * The three failures of one endpoint. `catchTag('RuntimeApiError', …)` narrows `apiError.code` to the
 * endpoint's declared codes plus the infrastructure `api_*` codes.
 *
 * `Extract<…, ApiError>` because `ApiEndpointError` of a deferred endpoint type is not provably an
 * `ApiError`.
 */
export type RuntimeEndpointError<Endpoint> =
  | RuntimeApiError<Extract<ApiEndpointError<Endpoint>, ApiError> | ApiInfrastructureError>
  | RuntimeDecodeError
  | RuntimeTransportError;

/** The same three failures for a content route, read from the content descriptor's `errors`. */
export type RuntimeContentEndpointError<Endpoint> =
  | RuntimeApiError<Extract<ApiContentEndpointError<Endpoint>, ApiError> | ApiInfrastructureError>
  | RuntimeDecodeError
  | RuntimeTransportError;

export type EndpointRequester = <Endpoint extends AnyApiEndpoint>(
  endpoint: Endpoint,
  ...args: ApiEndpointRequestArgs<Endpoint>
) => Effect.Effect<ApiEndpointOutput<Endpoint>, RuntimeEndpointError<Endpoint>>;

/**
 * A content route's bytes, unread. The body is read once: either as a `stream` (the CLI writes it to
 * a file) or whole as an `arrayBuffer` (the web turns it into a `Blob`).
 */
export interface RuntimeContent {
  readonly contentType: string | undefined;
  readonly stream: Stream.Stream<Uint8Array, RuntimeTransportError>;
  readonly arrayBuffer: Effect.Effect<ArrayBuffer, RuntimeTransportError>;
}

/** The route's own query values, such as a checkpoint file's `path`; undefined values are left out. */
export type ContentQuery = Readonly<Record<string, string | number | boolean | undefined>>;

export type ContentRequester = <Endpoint extends AnyApiContentEndpoint>(
  endpoint: Endpoint,
  params: Readonly<Record<string, string | number>>,
  query?: ContentQuery,
) => Effect.Effect<RuntimeContent, RuntimeContentEndpointError<Endpoint>>;

/** A content route's absolute URL, for `<img>` sources and download links that bypass the requester. */
export function contentEndpointUrl(
  runtimeUrl: string,
  endpoint: AnyApiContentEndpoint,
  params: Readonly<Record<string, string | number>>,
  query?: ContentQuery,
): string {
  return endpointUrl(runtimeUrl, endpoint.path, params, query).toString();
}

/**
 * The requesters for one runtime URL. Reads `HttpClient` once, so `request(...)` and
 * `requestContent(...)` have no requirements and call sites stay one line.
 *
 * `request` and `requestContent` are plain generic functions returning `Effect.gen`: a generic
 * generator passed to `Effect.fn` loses its type parameters.
 */
export const makeRequesters = Effect.fnUntraced(function* (runtimeUrl: string) {
  const client = yield* HttpClient.HttpClient;

  // Propagation is forced off on every request, whatever `HttpClient` the caller provided:
  // `traceparent`/`b3` headers would change the runtime's wire and make every browser GET a
  // CORS-preflighted request. Providing the reference next to the client layer does not reach here.
  const send = (endpointId: string, request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request).pipe(
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.mapError(
        (error) => new RuntimeTransportError({ endpointId, cause: platformCause(error) }),
      ),
    );

  const readJson = (endpointId: string, response: HttpClientResponse.HttpClientResponse) =>
    response.json.pipe(Effect.mapError((cause) => new RuntimeDecodeError({ endpointId, cause })));

  const decode = <S extends WireSchema>(endpointId: string, schema: S, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((cause) => new RuntimeDecodeError({ endpointId, cause })),
    );

  /** The endpoint's declared errors first, then the infrastructure arm, else a decode error. */
  const failWithEnvelope = (endpointId: string, errors: WireSchema, payload: unknown) =>
    decode(endpointId, apiErrorResponseSchema(errors), payload).pipe(
      Effect.catch(() =>
        decode(endpointId, apiErrorResponseSchema(apiInfrastructureErrorSchema), payload),
      ),
      Effect.flatMap((envelope) =>
        Effect.fail(new RuntimeApiError({ endpointId, apiError: envelope.error as never })),
      ),
    );

  const request: EndpointRequester = (endpoint, ...args) => {
    const values = args as readonly unknown[];
    const params = endpoint.params ? values[0] : undefined;
    const query = endpoint.query ? values[endpoint.params ? 1 : 0] : undefined;
    const body = endpoint.body
      ? values[(endpoint.params ? 1 : 0) + (endpoint.query ? 1 : 0)]
      : undefined;
    const url = endpointUrl(runtimeUrl, endpoint.path, params, query);
    // `JSON.stringify` of the caller's value with `content-type: application/json`, exactly the
    // bytes the runtime has always received; the body is not schema-encoded.
    const httpRequest = endpoint.body
      ? HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.make(endpoint.method)(url), body)
      : HttpClientRequest.make(endpoint.method)(url);
    return Effect.gen(function* () {
      const response = yield* send(endpoint.id, httpRequest);
      const payload = yield* readJson(endpoint.id, response);
      if (!isOk(response)) {
        return yield* failWithEnvelope(endpoint.id, endpoint.errors, payload);
      }
      const envelope = yield* decode(
        endpoint.id,
        apiSuccessResponseSchema(endpoint.output),
        payload,
      );
      return envelope.data as ApiEndpointOutput<typeof endpoint>;
    }).pipe(Effect.withSpan('RuntimeClient.request', { attributes: { endpointId: endpoint.id } }));
  };

  // A content route's success body is not the JSON envelope, so it is handed back unread; a failure
  // still is the envelope and decodes exactly as `request` decodes one.
  const requestContent: ContentRequester = (endpoint, params, query) =>
    Effect.gen(function* () {
      const response = yield* send(
        endpoint.id,
        HttpClientRequest.get(endpointUrl(runtimeUrl, endpoint.path, params, query)),
      );
      if (!isOk(response)) {
        const payload = yield* readJson(endpoint.id, response);
        return yield* failWithEnvelope(endpoint.id, endpoint.errors, payload);
      }
      const toTransport = (error: HttpClientError.HttpClientError) =>
        new RuntimeTransportError({ endpointId: endpoint.id, cause: platformCause(error) });
      const content: RuntimeContent = {
        contentType: response.headers['content-type'],
        stream: response.stream.pipe(Stream.mapError(toTransport)),
        arrayBuffer: response.arrayBuffer.pipe(Effect.mapError(toTransport)),
      };
      return content;
    }).pipe(
      Effect.withSpan('RuntimeClient.requestContent', { attributes: { endpointId: endpoint.id } }),
    );

  return { runtimeUrl, request, requestContent } as const;
});

function isOk(response: HttpClientResponse.HttpClientResponse) {
  return response.status >= 200 && response.status < 300;
}

/** The platform error behind an `effect/http` failure, when it carries one. */
function platformCause(error: HttpClientError.HttpClientError): unknown {
  return 'cause' in error.reason && error.reason.cause !== undefined ? error.reason.cause : error;
}

function endpointUrl(runtimeUrl: string, path: string, params: unknown, query: unknown): URL {
  const url = new URL(`${apiBasePath}${interpolatePath(path, params)}`, runtimeUrl);
  appendQuery(url, query);
  return url;
}

function appendQuery(url: URL, query: unknown) {
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
