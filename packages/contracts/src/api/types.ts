import type { Schema } from 'effect';

export type ApiMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

export interface ApiEndpoint<
  Body extends Schema.Schema.AnyNoContext | undefined,
  Output extends Schema.Schema.AnyNoContext,
  Errors extends Schema.Schema.AnyNoContext,
  Params extends Schema.Schema.AnyNoContext | undefined = undefined,
> {
  readonly id: string;
  readonly method: ApiMethod;
  readonly path: `/${string}`;
  readonly params?: Params;
  readonly body?: Body;
  readonly output: Output;
  readonly errors: Errors;
}

export type ApiEndpointBody<Endpoint> =
  Endpoint extends ApiEndpoint<infer Body, infer _Output, infer _Errors, infer _Params>
    ? Body extends Schema.Schema.AnyNoContext
      ? Schema.Schema.Type<Body>
      : undefined
    : never;

export type ApiEndpointOutput<Endpoint> =
  Endpoint extends ApiEndpoint<infer _Body, infer Output, infer _Errors, infer _Params>
    ? Schema.Schema.Type<Output>
    : never;

export type ApiEndpointParams<Endpoint> =
  Endpoint extends ApiEndpoint<infer _Body, infer _Output, infer _Errors, infer Params>
    ? Params extends Schema.Schema.AnyNoContext
      ? Schema.Schema.Type<Params>
      : undefined
    : never;

export type ApiEndpointError<Endpoint> =
  Endpoint extends ApiEndpoint<infer _Body, infer _Output, infer Errors, infer _Params>
    ? Schema.Schema.Type<Errors>
    : never;

export type ApiEndpointRequestArgs<Endpoint> =
  ApiEndpointParams<Endpoint> extends undefined
    ? ApiEndpointBody<Endpoint> extends undefined
      ? []
      : [body: ApiEndpointBody<Endpoint>]
    : ApiEndpointBody<Endpoint> extends undefined
      ? [params: ApiEndpointParams<Endpoint>]
      : [params: ApiEndpointParams<Endpoint>, body: ApiEndpointBody<Endpoint>];
