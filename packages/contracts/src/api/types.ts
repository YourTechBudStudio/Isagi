import type { Schema } from 'effect';

export type ApiMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

export interface ApiEndpoint<
  Body extends Schema.Schema.AnyNoContext | undefined,
  Output extends Schema.Schema.AnyNoContext,
  Errors extends Schema.Schema.AnyNoContext,
  Params extends Schema.Schema.AnyNoContext | undefined = undefined,
  Query extends Schema.Schema.AnyNoContext | undefined = undefined,
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

export type ApiEndpointBody<Endpoint> =
  Endpoint extends ApiEndpoint<
    infer Body,
    infer _Output,
    infer _Errors,
    infer _Params,
    infer _Query
  >
    ? Body extends Schema.Schema.AnyNoContext
      ? Schema.Schema.Type<Body>
      : undefined
    : never;

export type ApiEndpointOutput<Endpoint> =
  Endpoint extends ApiEndpoint<
    infer _Body,
    infer Output,
    infer _Errors,
    infer _Params,
    infer _Query
  >
    ? Schema.Schema.Type<Output>
    : never;

export type ApiEndpointParams<Endpoint> =
  Endpoint extends ApiEndpoint<
    infer _Body,
    infer _Output,
    infer _Errors,
    infer Params,
    infer _Query
  >
    ? Params extends Schema.Schema.AnyNoContext
      ? Schema.Schema.Type<Params>
      : undefined
    : never;

export type ApiEndpointQuery<Endpoint> =
  Endpoint extends ApiEndpoint<
    infer _Body,
    infer _Output,
    infer _Errors,
    infer _Params,
    infer Query
  >
    ? Query extends Schema.Schema.AnyNoContext
      ? Schema.Schema.Type<Query>
      : undefined
    : never;

export type ApiEndpointError<Endpoint> =
  Endpoint extends ApiEndpoint<
    infer _Body,
    infer _Output,
    infer Errors,
    infer _Params,
    infer _Query
  >
    ? Schema.Schema.Type<Errors>
    : never;

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
  Errors extends Schema.Schema.AnyNoContext,
  Params extends Schema.Schema.AnyNoContext | undefined = undefined,
  Query extends Schema.Schema.AnyNoContext | undefined = undefined,
> {
  readonly id: string;
  readonly method: 'GET';
  readonly path: `/${string}`;
  readonly params?: Params;
  readonly query?: Query;
  readonly errors: Errors;
}

export type ApiContentEndpointParams<Endpoint> =
  Endpoint extends ApiContentEndpoint<infer _Errors, infer Params, infer _Query>
    ? Params extends Schema.Schema.AnyNoContext
      ? Schema.Schema.Type<Params>
      : undefined
    : never;

export type ApiContentEndpointQuery<Endpoint> =
  Endpoint extends ApiContentEndpoint<infer _Errors, infer _Params, infer Query>
    ? Query extends Schema.Schema.AnyNoContext
      ? Schema.Schema.Type<Query>
      : undefined
    : never;

export type ApiContentEndpointError<Endpoint> =
  Endpoint extends ApiContentEndpoint<infer Errors, infer _Params, infer _Query>
    ? Schema.Schema.Type<Errors>
    : never;
