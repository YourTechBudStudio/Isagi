import assert from 'node:assert/strict';
import test from 'node:test';

import { Schema } from 'effect';

import type {
  ApiContentEndpoint,
  ApiContentEndpointParams,
  ApiEndpoint,
  ApiEndpointBody,
  ApiEndpointParams,
  ApiEndpointQuery,
  ApiEndpointRequestArgs,
} from './types.js';

/**
 * The part helpers must read a descriptor's parts whether it keeps its literal type
 * (`as const satisfies ApiEndpoint<…>`) or is annotated as `ApiEndpoint<…>`, whose
 * `params`/`query`/`body` are optional properties. Losing a part would let
 * `client.request(endpoint)` type-check without the path params and send a literal `:id`.
 * These are compile-time checks: `tsc -p tsconfig.test.json` fails if they regress.
 */

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const params = Schema.Struct({ id: Schema.String });
const query = Schema.Struct({ limit: Schema.Number });
const body = Schema.Struct({ name: Schema.String });
const output = Schema.Struct({ ok: Schema.Boolean });
const errors = Schema.Struct({ code: Schema.Literal('rejected') });

type Params = typeof params.Type;
type Query = typeof query.Type;
type Body = typeof body.Type;

const annotated: ApiEndpoint<
  typeof body,
  typeof output,
  typeof errors,
  typeof params,
  typeof query
> = { id: 'annotated', method: 'POST', path: '/x/:id', params, query, body, output, errors };

const literal = {
  id: 'literal',
  method: 'POST',
  path: '/x/:id',
  params,
  query,
  body,
  output,
  errors,
} as const satisfies ApiEndpoint<
  typeof body,
  typeof output,
  typeof errors,
  typeof params,
  typeof query
>;

const annotatedParamsOnly: ApiEndpoint<undefined, typeof output, typeof errors, typeof params> = {
  id: 'annotated-params-only',
  method: 'GET',
  path: '/x/:id',
  params,
  output,
  errors,
};

const bare = {
  id: 'bare',
  method: 'GET',
  path: '/x',
  output,
  errors,
} as const satisfies ApiEndpoint<undefined, typeof output, typeof errors>;

const annotatedContent: ApiContentEndpoint<typeof errors, typeof params> = {
  id: 'content',
  method: 'GET',
  path: '/x/:id/content',
  params,
  errors,
};

test('an annotated descriptor keeps its declared parts, like an as-const one', () => {
  const checks: ReadonlyArray<true> = [
    true satisfies Equals<ApiEndpointParams<typeof annotated>, Params>,
    true satisfies Equals<ApiEndpointQuery<typeof annotated>, Query>,
    true satisfies Equals<ApiEndpointBody<typeof annotated>, Body>,
    true satisfies Equals<
      ApiEndpointRequestArgs<typeof annotated>,
      ApiEndpointRequestArgs<typeof literal>
    >,
    true satisfies Equals<ApiEndpointRequestArgs<typeof annotatedParamsOnly>, [params: Params]>,
    true satisfies Equals<ApiContentEndpointParams<typeof annotatedContent>, Params>,
  ];
  assert.equal(checks.length, 6);
});

test('an undeclared part stays undefined', () => {
  const checks: ReadonlyArray<true> = [
    true satisfies Equals<ApiEndpointParams<typeof bare>, undefined>,
    true satisfies Equals<ApiEndpointQuery<typeof annotatedParamsOnly>, undefined>,
    true satisfies Equals<ApiEndpointBody<typeof annotatedParamsOnly>, undefined>,
    true satisfies Equals<ApiEndpointRequestArgs<typeof bare>, []>,
  ];
  assert.equal(checks.length, 4);
});
