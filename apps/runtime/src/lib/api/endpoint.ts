import { Effect, Either, Schema } from 'effect';
import type { FastifyInstance } from 'fastify';

import {
  apiBasePath,
  apiSuccessResponseSchema,
  type ApiEndpoint,
  type ApiEndpointBody,
  type ApiEndpointOutput,
  type ApiEndpointParams,
  type ApiEndpointQuery,
  type ApiError,
} from '@isagi/contracts';

import { logDiagnosticEvent } from '../../diagnostics/phase.js';
import {
  requestDecodingFailed,
  responseEncodingFailed,
  sendApiError,
  unhandledApiError,
  type ApiRouteContext,
} from './errors.js';
import {
  decodeParams,
  decodeQuery,
  logSlowApiRequest,
  requestInterruptSignal,
  sendRouteApiError,
  slowApiRequestThresholdMs,
} from './route-runtime.js';

export interface RegisterApiEndpointOptions<
  Endpoint extends ApiEndpoint<
    Schema.Schema.AnyNoContext | undefined,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext | undefined,
    Schema.Schema.AnyNoContext | undefined
  >,
  R,
> {
  readonly handle: (
    input: ApiEndpointBody<Endpoint>,
    context: ApiRouteContext,
    params: ApiEndpointParams<Endpoint>,
    query: ApiEndpointQuery<Endpoint>,
  ) => Effect.Effect<ApiEndpointOutput<Endpoint>, unknown, R>;
  readonly mapError?: (error: unknown, context: ApiRouteContext) => ApiError;
  readonly run: <A>(
    effect: Effect.Effect<A, unknown, R>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) => Promise<A>;
}

export function registerApiEndpoint<
  Endpoint extends ApiEndpoint<
    Schema.Schema.AnyNoContext | undefined,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext | undefined,
    Schema.Schema.AnyNoContext | undefined
  >,
  R = never,
>(fastify: FastifyInstance, endpoint: Endpoint, options: RegisterApiEndpointOptions<Endpoint, R>) {
  fastify.route({
    method: endpoint.method,
    url: `${apiBasePath}${endpoint.path}`,
    handler: async (request, reply) => {
      const context = {
        endpointId: endpoint.id,
        requestId: String(request.id),
      } satisfies ApiRouteContext;

      const input = decodeInput(endpoint, request.body, context);
      if (input.status === 'failed') {
        return sendApiError(reply, input.error);
      }
      const params = decodeParams<ApiEndpointParams<Endpoint>>(endpoint, request.params, context);
      if (params.status === 'failed') {
        return sendApiError(reply, params.error);
      }
      const query = decodeQuery<ApiEndpointQuery<Endpoint>>(endpoint, request.query, context);
      if (query.status === 'failed') {
        return sendApiError(reply, query.error);
      }

      const interrupt = requestInterruptSignal(request, reply);
      const handlerStartedAt = Date.now();
      let slowRequestLogged = false;
      const slowRequestTimer = setTimeout(() => {
        slowRequestLogged = true;
        logDiagnosticEvent(
          'api.request_still_running',
          {
            endpointId: endpoint.id,
            requestId: context.requestId,
            method: request.method,
            url: request.url,
            elapsedMs: Date.now() - handlerStartedAt,
          },
          'warn',
        );
      }, slowApiRequestThresholdMs);
      slowRequestTimer.unref();
      let output: ApiEndpointOutput<Endpoint>;
      try {
        const result = await options.run(
          Effect.either(options.handle(input.value, context, params.value, query.value)),
          {
            signal: interrupt.signal,
          },
        );
        if (Either.isLeft(result)) {
          logSlowApiRequest({
            context,
            elapsedMs: Date.now() - handlerStartedAt,
            endpointId: endpoint.id,
            method: request.method,
            outcome: 'failed',
            slowRequestLogged,
            url: request.url,
          });
          const apiError =
            options.mapError?.(result.left, context) ?? unhandledApiError(context, result.left);
          return sendRouteApiError(request, reply, endpoint, context, apiError);
        }
        output = result.right;
      } catch (error: unknown) {
        if (interrupt.signal.aborted || reply.raw.destroyed) {
          logSlowApiRequest({
            context,
            elapsedMs: Date.now() - handlerStartedAt,
            endpointId: endpoint.id,
            method: request.method,
            outcome: 'aborted',
            slowRequestLogged,
            url: request.url,
          });
          return;
        }
        logSlowApiRequest({
          context,
          elapsedMs: Date.now() - handlerStartedAt,
          endpointId: endpoint.id,
          method: request.method,
          outcome: 'threw',
          slowRequestLogged,
          url: request.url,
        });
        const apiError = unhandledApiError(context, error);
        return sendRouteApiError(request, reply, endpoint, context, apiError);
      } finally {
        clearTimeout(slowRequestTimer);
        interrupt.cleanup();
      }
      logSlowApiRequest({
        context,
        elapsedMs: Date.now() - handlerStartedAt,
        endpointId: endpoint.id,
        method: request.method,
        outcome: 'succeeded',
        slowRequestLogged,
        url: request.url,
      });

      if (interrupt.signal.aborted || reply.raw.destroyed) {
        return;
      }

      try {
        const envelope = Schema.decodeUnknownSync(apiSuccessResponseSchema(endpoint.output))({
          data: output,
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

function decodeInput<
  Endpoint extends ApiEndpoint<
    Schema.Schema.AnyNoContext | undefined,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext | undefined,
    Schema.Schema.AnyNoContext | undefined
  >,
>(endpoint: Endpoint, body: unknown, context: ApiRouteContext) {
  const bodySchema = endpoint.body as Schema.Schema.AnyNoContext | undefined;

  if (!bodySchema) {
    return { status: 'succeeded' as const, value: undefined as ApiEndpointBody<Endpoint> };
  }

  try {
    return {
      status: 'succeeded' as const,
      value: Schema.decodeUnknownSync(bodySchema)(body) as ApiEndpointBody<Endpoint>,
    };
  } catch (error: unknown) {
    return { status: 'failed' as const, error: requestDecodingFailed(context, error) };
  }
}
