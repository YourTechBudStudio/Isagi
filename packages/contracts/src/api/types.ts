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
