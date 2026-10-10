import { Effect, Result, Schema } from 'effect';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  apiBasePath,
  apiInfrastructureErrorSchema,
  apiSuccessResponseSchema,
  type AnyApiContentEndpoint,
  type AnyApiEndpoint,
  type ApiContentEndpointParams,
  type ApiContentEndpointQuery,
  type ApiEndpointBody,
  type ApiEndpointOutput,
  type ApiEndpointParams,
  type ApiEndpointQuery,
  type ApiError,
  type WireSchema,
} from '@isagi/contracts';

import { sendContent, type ContentResponse } from './content-endpoint.js';
import {
  requestDecodingFailed,
  responseEncodingFailed,
  sendApiError,
  unhandledApiError,
  type ApiRouteContext,
} from './errors.js';
import { coerceRouteParams, runRouteRequest, type RouteRuntime } from './route-runtime.js';

/**
 * TRANSITIONAL (plan R20): the untyped endpoint helpers every module route used before `registerApiEndpoint` /
 * `registerContentEndpoint` typed the handler's error channel. A handler fails with `unknown` and an optional
 * `mapError` turns the failure into an `ApiError`; anything unmapped is `api_unhandled_error`. Module routes move to
 * the typed helpers in S4, and S4.Z deletes this file. Do not register new routes here.
 *
 * Requests run through the same `runRouteRequest` glue as the typed helpers: the request interrupt signal, the
 * endpoint/request log annotations and the slow-request diagnostics are shared.
 */

export interface RegisterLegacyApiEndpointOptions<Endpoint extends AnyApiEndpoint, R> {
  readonly handle: (
    input: ApiEndpointBody<Endpoint>,
    context: ApiRouteContext,
    params: ApiEndpointParams<Endpoint>,
    query: ApiEndpointQuery<Endpoint>,
  ) => Effect.Effect<ApiEndpointOutput<Endpoint>, unknown, R>;
  readonly mapError?: (error: unknown, context: ApiRouteContext) => ApiError;
}

export function registerLegacyApiEndpoint<Endpoint extends AnyApiEndpoint, R>(
  fastify: FastifyInstance,
  runtime: RouteRuntime<R>,
  endpoint: Endpoint,
  options: RegisterLegacyApiEndpointOptions<Endpoint, NoInfer<R>>,
) {
  fastify.route({
    method: endpoint.method,
    url: `${apiBasePath}${endpoint.path}`,
    handler: async (request, reply) => {
      const context = {
        endpointId: endpoint.id,
        requestId: String(request.id),
      } satisfies ApiRouteContext;

      const input = decodeWith<ApiEndpointBody<Endpoint>>(endpoint.body, request.body, context);
      if (input.status === 'failed') {
        return sendApiError(reply, input.error);
      }
      const params = decodeWith<ApiEndpointParams<Endpoint>>(
        endpoint.params,
        coerceRouteParams(request.params),
        context,
      );
      if (params.status === 'failed') {
        return sendApiError(reply, params.error);
      }
      const query = decodeWith<ApiEndpointQuery<Endpoint>>(
        endpoint.query,
        coerceRouteParams(request.query),
        context,
      );
      if (query.status === 'failed') {
        return sendApiError(reply, query.error);
      }

      const result = await runRouteRequest(
        runtime,
        request,
        reply,
        context,
        Effect.result(options.handle(input.value, context, params.value, query.value)),
        (outcome) => (Result.isFailure(outcome) ? 'failed' : 'succeeded'),
      );
      if (result._tag === 'Rejected') {
        if (result.clientGone) return;
        return sendRouteApiError(
          request,
          reply,
          endpoint,
          context,
          unhandledApiError(context, result.cause),
        );
      }
      if (Result.isFailure(result.value)) {
        const apiError =
          options.mapError?.(result.value.failure, context) ??
          unhandledApiError(context, result.value.failure);
        return sendRouteApiError(request, reply, endpoint, context, apiError);
      }
      if (result.clientGone) {
        return;
      }

      try {
        const envelope = Schema.decodeUnknownSync(apiSuccessResponseSchema(endpoint.output))({
          data: result.value.success,
          meta: { requestId: context.requestId },
        });
        return reply.status(200).send(envelope);
      } catch (error: unknown) {
        request.log.error({ error, endpointId: endpoint.id }, 'API response encoding failed');
        return sendApiError(reply, responseEncodingFailed(context, error));
      }
    },
  });
}

export interface RegisterLegacyContentEndpointOptions<Endpoint extends AnyApiContentEndpoint, R> {
  readonly handle: (
    context: ApiRouteContext,
    params: ApiContentEndpointParams<Endpoint>,
    query: ApiContentEndpointQuery<Endpoint>,
  ) => Effect.Effect<ContentResponse, unknown, R>;
  /** Whether this request asked for a download rather than an inline view. */
  readonly attachment?: (query: ApiContentEndpointQuery<Endpoint>) => boolean;
  readonly mapError?: (error: unknown, context: ApiRouteContext) => ApiError;
}

export function registerLegacyContentEndpoint<Endpoint extends AnyApiContentEndpoint, R>(
  fastify: FastifyInstance,
  runtime: RouteRuntime<R>,
  endpoint: Endpoint,
  options: RegisterLegacyContentEndpointOptions<Endpoint, NoInfer<R>>,
) {
  fastify.route({
    method: endpoint.method,
    url: `${apiBasePath}${endpoint.path}`,
    handler: async (request, reply) => {
      const context = {
        endpointId: endpoint.id,
        requestId: String(request.id),
      } satisfies ApiRouteContext;

      const params = decodeWith<ApiContentEndpointParams<Endpoint>>(
        endpoint.params,
        coerceRouteParams(request.params),
        context,
      );
      if (params.status === 'failed') {
        return sendApiError(reply, params.error);
      }
      const query = decodeWith<ApiContentEndpointQuery<Endpoint>>(
        endpoint.query,
        coerceRouteParams(request.query),
        context,
      );
      if (query.status === 'failed') {
        return sendApiError(reply, query.error);
      }

      const result = await runRouteRequest(
        runtime,
        request,
        reply,
        context,
        Effect.result(options.handle(context, params.value, query.value)),
        (outcome) => (Result.isFailure(outcome) ? 'failed' : 'succeeded'),
      );
      if (result._tag === 'Rejected') {
        if (result.clientGone) return;
        return sendRouteApiError(
          request,
          reply,
          endpoint,
          context,
          unhandledApiError(context, result.cause),
        );
      }
      if (Result.isFailure(result.value)) {
        const apiError =
          options.mapError?.(result.value.failure, context) ??
          unhandledApiError(context, result.value.failure);
        return sendRouteApiError(request, reply, endpoint, context, apiError);
      }
      return sendContent(
        runtime,
        request,
        reply,
        context,
        result.value.success,
        options.attachment?.(query.value) === true,
        result.clientGone,
      );
    },
  });
}

type Decoded<Value> =
  | { readonly status: 'succeeded'; readonly value: Value }
  | { readonly status: 'failed'; readonly error: ApiError };

function decodeWith<Value>(
  schema: unknown,
  value: unknown,
  context: ApiRouteContext,
): Decoded<Value> {
  const decoder = schema as WireSchema | undefined;
  if (!decoder) {
    return { status: 'succeeded', value: undefined as Value };
  }
  try {
    return { status: 'succeeded', value: Schema.decodeUnknownSync(decoder)(value) as Value };
  } catch (error: unknown) {
    return { status: 'failed', error: requestDecodingFailed(context, error) };
  }
}

/**
 * Sends an error against the schema the endpoint actually declares, so a route can never emit a
 * rejection its own contract does not describe.
 */
function sendRouteApiError(
  request: FastifyRequest,
  reply: FastifyReply,
  endpoint: { readonly id: string; readonly errors: unknown },
  context: ApiRouteContext,
  apiError: ApiError,
) {
  const errorSchema = apiError.code.startsWith('api_')
    ? apiInfrastructureErrorSchema
    : (endpoint.errors as WireSchema);

  try {
    Schema.decodeUnknownSync(errorSchema)(apiError);
    return sendApiError(reply, apiError);
  } catch (error: unknown) {
    request.log.error({ error, endpointId: endpoint.id }, 'API error encoding failed');
    return sendApiError(reply, responseEncodingFailed(context, error));
  }
}
