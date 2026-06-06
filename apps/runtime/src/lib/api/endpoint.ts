import { Effect, Schema } from 'effect';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  apiBasePath,
  apiInfrastructureErrorSchema,
  apiSuccessResponseSchema,
  type ApiEndpoint,
  type ApiEndpointBody,
  type ApiEndpointOutput,
  type ApiError,
} from '@isagi/contracts';

import {
  requestDecodingFailed,
  responseEncodingFailed,
  sendApiError,
  unhandledApiError,
  type ApiRouteContext,
} from './errors.js';

export interface RegisterApiEndpointOptions<
  Endpoint extends ApiEndpoint<
    Schema.Schema.AnyNoContext | undefined,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext
  >,
  R,
> {
  readonly handle: (
    input: ApiEndpointBody<Endpoint>,
    context: ApiRouteContext,
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
    Schema.Schema.AnyNoContext
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

      const interrupt = requestInterruptSignal(request, reply);
      let output: ApiEndpointOutput<Endpoint>;
      try {
        output = await options.run(options.handle(input.value, context), {
          signal: interrupt.signal,
        });
      } catch (error: unknown) {
        if (interrupt.signal.aborted || reply.raw.destroyed) {
          return;
        }
        const apiError = options.mapError?.(error, context) ?? unhandledApiError(context, error);
        return sendRouteApiError(request, reply, endpoint, context, apiError);
      } finally {
        interrupt.cleanup();
      }

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
    Schema.Schema.AnyNoContext
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
    Schema.Schema.AnyNoContext
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
