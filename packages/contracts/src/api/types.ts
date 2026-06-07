import type { Schema } from 'effect';

export type ApiMethod = 'GET' | 'PATCH' | 'POST' | 'PUT';

export interface ApiEndpoint<
  Body extends Schema.Schema.AnyNoContext | undefined,
  Output extends Schema.Schema.AnyNoContext,
  Errors extends Schema.Schema.AnyNoContext,
> {
  readonly id: string;
  readonly method: ApiMethod;
  readonly path: `/${string}`;
  readonly body?: Body;
  readonly output: Output;
  readonly errors: Errors;
}

export type ApiEndpointBody<Endpoint> =
  Endpoint extends ApiEndpoint<infer Body, infer _Output, infer _Errors>
    ? Body extends Schema.Schema.AnyNoContext
      ? Schema.Schema.Type<Body>
      : undefined
    : never;

export type ApiEndpointOutput<Endpoint> =
  Endpoint extends ApiEndpoint<infer _Body, infer Output, infer _Errors>
    ? Schema.Schema.Type<Output>
    : never;

export type ApiEndpointError<Endpoint> =
  Endpoint extends ApiEndpoint<infer _Body, infer _Output, infer Errors>
    ? Schema.Schema.Type<Errors>
    : never;
