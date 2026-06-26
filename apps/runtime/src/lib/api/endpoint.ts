import { Effect, Either, Schema } from 'effect';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  apiBasePath,
  apiInfrastructureErrorSchema,
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

const slowApiRequestThresholdMs = 1_000;

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
      const params = decodeParams(endpoint, request.params, context);
      if (params.status === 'failed') {
        return sendApiError(reply, params.error);
      }
      const query = decodeQuery(endpoint, request.query, context);
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

function logSlowApiRequest(input: {
  readonly context: ApiRouteContext;
  readonly elapsedMs: number;
  readonly endpointId: string;
  readonly method: string;
  readonly outcome: 'aborted' | 'failed' | 'succeeded' | 'threw';
  readonly slowRequestLogged: boolean;
  readonly url: string;
}) {
  if (!input.slowRequestLogged && input.elapsedMs < slowApiRequestThresholdMs) return;
  logDiagnosticEvent(
    'api.request_completed',
    {
      endpointId: input.endpointId,
      requestId: input.context.requestId,
      method: input.method,
      url: input.url,
      outcome: input.outcome,
      elapsedMs: input.elapsedMs,
    },
    input.outcome === 'succeeded' ? 'info' : 'warn',
  );
}

function decodeParams<
  Endpoint extends ApiEndpoint<
    Schema.Schema.AnyNoContext | undefined,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext | undefined,
    Schema.Schema.AnyNoContext | undefined
  >,
>(endpoint: Endpoint, params: unknown, context: ApiRouteContext) {
  const paramsSchema = endpoint.params as Schema.Schema.AnyNoContext | undefined;

  if (!paramsSchema) {
    return { status: 'succeeded' as const, value: undefined as ApiEndpointParams<Endpoint> };
  }

  try {
    return {
      status: 'succeeded' as const,
      value: Schema.decodeUnknownSync(paramsSchema)(
        coerceRouteParams(params),
      ) as ApiEndpointParams<Endpoint>,
    };
  } catch (error: unknown) {
    return { status: 'failed' as const, error: requestDecodingFailed(context, error) };
  }
}

function decodeQuery<
  Endpoint extends ApiEndpoint<
    Schema.Schema.AnyNoContext | undefined,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext | undefined,
    Schema.Schema.AnyNoContext | undefined
  >,
>(endpoint: Endpoint, query: unknown, context: ApiRouteContext) {
  const querySchema = endpoint.query as Schema.Schema.AnyNoContext | undefined;

  if (!querySchema) {
    return { status: 'succeeded' as const, value: undefined as ApiEndpointQuery<Endpoint> };
  }

  try {
    return {
      status: 'succeeded' as const,
      value: Schema.decodeUnknownSync(querySchema)(
        coerceRouteParams(query),
      ) as ApiEndpointQuery<Endpoint>,
    };
  } catch (error: unknown) {
    return { status: 'failed' as const, error: requestDecodingFailed(context, error) };
  }
}

function coerceRouteParams(params: unknown) {
  if (!params || typeof params !== 'object') {
    return params;
  }

  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => {
      const numeric = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
      return [key, numeric];
    }),
  );
}

function requestInterruptSignal(request: FastifyRequest, reply: FastifyReply) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(`API request interrupted: ${request.method} ${request.url}`));
    }
  };
  const abortOnResponseClose = () => {
    if (!reply.raw.writableEnded) {
      abort();
    }
  };

  request.raw.once('aborted', abort);
  request.raw.once('timeout', abort);
  request.socket.once('timeout', abort);
  reply.raw.once('close', abortOnResponseClose);

  return {
    signal: controller.signal,
    cleanup: () => {
      request.raw.off('aborted', abort);
      request.raw.off('timeout', abort);
      request.socket.off('timeout', abort);
      reply.raw.off('close', abortOnResponseClose);
    },
  };
}

function sendRouteApiError<
  Endpoint extends ApiEndpoint<
    Schema.Schema.AnyNoContext | undefined,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext | undefined,
    Schema.Schema.AnyNoContext | undefined
  >,
>(
  request: FastifyRequest,
  reply: FastifyReply,
  endpoint: Endpoint,
  context: ApiRouteContext,
  apiError: ApiError,
) {
  const errorSchema = apiError.code.startsWith('api_')
    ? apiInfrastructureErrorSchema
    : endpoint.errors;

  try {
    Schema.decodeUnknownSync(errorSchema)(apiError);
    return sendApiError(reply, apiError);
  } catch (error: unknown) {
    request.log.error({ error, endpointId: endpoint.id }, 'API error encoding failed');
    return sendApiError(reply, responseEncodingFailed(context, error));
  }
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
