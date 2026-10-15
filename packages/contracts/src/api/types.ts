import type { Schema } from 'effect';

export type ApiMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

/** Any wire schema: no decoding or encoding services. */
export type WireSchema = Schema.Codec<unknown>;

/** The bound every requester and route registrar accepts. */
export type AnyApiEndpoint = ApiEndpoint<
  WireSchema | undefined,
  WireSchema,
  WireSchema,
  WireSchema | undefined,
  WireSchema | undefined
>;

export type AnyApiContentEndpoint = ApiContentEndpoint<
  WireSchema,
  WireSchema | undefined,
  WireSchema | undefined
>;

export type AnyApiEventStreamEndpoint = ApiEventStreamEndpoint<WireSchema, WireSchema | undefined>;

export interface ApiEndpoint<
  Body extends WireSchema | undefined,
  Output extends WireSchema,
  Errors extends WireSchema,
  Params extends WireSchema | undefined = undefined,
  Query extends WireSchema | undefined = undefined,
> {
  readonly id: string;
  readonly method: ApiMethod;
  readonly path: `/${string}`;
  readonly params?: Params;
  readonly query?: Query;
  readonly body?: Body;
  readonly output: Output;
  readonly errors: Errors;
}

/**
 * A declared part's decoded type, or `undefined` when the endpoint does not declare that part.
 *
 * The part is read as an optional property so a descriptor annotated as `ApiEndpoint<…>` (whose
 * `params`/`query`/`body` are optional) keeps its parts, the same as an `as const satisfies` one.
 */
type PartType<Endpoint, Part extends string> = Endpoint extends {
  readonly [K in Part]?: infer S;
}
  ? [Exclude<S, undefined>] extends [never]
    ? undefined
    : [Exclude<S, undefined>] extends [WireSchema]
      ? Exclude<S, undefined>['Type']
      : undefined
  : undefined;

export type ApiEndpointBody<Endpoint> = PartType<Endpoint, 'body'>;
export type ApiEndpointOutput<Endpoint> = PartType<Endpoint, 'output'>;
export type ApiEndpointParams<Endpoint> = PartType<Endpoint, 'params'>;
export type ApiEndpointQuery<Endpoint> = PartType<Endpoint, 'query'>;
export type ApiEndpointError<Endpoint> = PartType<Endpoint, 'errors'>;

export type ApiEndpointRequestArgs<Endpoint> =
  ApiEndpointParams<Endpoint> extends undefined
    ? ApiEndpointQuery<Endpoint> extends undefined
      ? ApiEndpointBody<Endpoint> extends undefined
        ? []
        : [body: ApiEndpointBody<Endpoint>]
      : ApiEndpointBody<Endpoint> extends undefined
        ? [query: ApiEndpointQuery<Endpoint>]
        : [query: ApiEndpointQuery<Endpoint>, body: ApiEndpointBody<Endpoint>]
    : ApiEndpointQuery<Endpoint> extends undefined
      ? ApiEndpointBody<Endpoint> extends undefined
        ? [params: ApiEndpointParams<Endpoint>]
        : [params: ApiEndpointParams<Endpoint>, body: ApiEndpointBody<Endpoint>]
      : ApiEndpointBody<Endpoint> extends undefined
        ? [params: ApiEndpointParams<Endpoint>, query: ApiEndpointQuery<Endpoint>]
        : [
            params: ApiEndpointParams<Endpoint>,
            query: ApiEndpointQuery<Endpoint>,
            body: ApiEndpointBody<Endpoint>,
          ];

/**
 * A route whose success body is bytes rather than the JSON success envelope.
 *
 * Declared as its own descriptor kind rather than special-cased at one route, because
 * `registerApiEndpoint` always wraps output in `apiSuccessResponseSchema` and the typed web
 * requester always calls `response.json()`. There is deliberately no `output` schema: what the
 * route returns is a stream, a media type and a length, none of which a wire schema can describe.
 * Failures are the ordinary JSON error envelope, so a client can rely on it for any non-200.
 *
 * It is not a member of a `Record<string, ApiEndpoint>` collection and must not be made one: the
 * typed requester's argument and output inference is built on `ApiEndpoint`, and a content route
 * has no output to infer.
 */
export interface ApiContentEndpoint<
  Errors extends WireSchema,
  Params extends WireSchema | undefined = undefined,
  Query extends WireSchema | undefined = undefined,
> {
  readonly id: string;
  readonly method: 'GET';
  readonly path: `/${string}`;
  readonly params?: Params;
  readonly query?: Query;
  readonly errors: Errors;
}

export type ApiContentEndpointParams<Endpoint> = PartType<Endpoint, 'params'>;
export type ApiContentEndpointQuery<Endpoint> = PartType<Endpoint, 'query'>;
export type ApiContentEndpointError<Endpoint> = PartType<Endpoint, 'errors'>;

/**
 * A route whose success body is a server-sent event stream rather than the JSON success envelope.
 *
 * Like a content route, it is its own descriptor kind and never a member of an `ApiEndpoint`
 * collection. It has no `output` schema: each event's `data` is one JSON value its owner encodes
 * with its own schema, which a wire schema here cannot describe when the payload is opaque to
 * contracts. A refusal before the stream opens is the ordinary JSON error envelope, so a client can
 * rely on it for any non-200.
 */
export interface ApiEventStreamEndpoint<
  Errors extends WireSchema,
  Params extends WireSchema | undefined = undefined,
> {
  readonly id: string;
  readonly method: 'GET';
  readonly path: `/${string}`;
  readonly params?: Params;
  readonly errors: Errors;
}

export type ApiEventStreamEndpointParams<Endpoint> = PartType<Endpoint, 'params'>;
export type ApiEventStreamEndpointError<Endpoint> = PartType<Endpoint, 'errors'>;
