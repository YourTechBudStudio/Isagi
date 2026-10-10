import type { FastifyReply } from 'fastify';

import type { ApiError } from '@isagi/contracts';

export interface ApiRouteContext {
  readonly endpointId: string;
  readonly requestId: string;
}

export function requestDecodingFailed(context: ApiRouteContext, cause: unknown): ApiError {
  return {
    code: 'api_request_decoding_failed',
    status: 400,
    message: 'Request payload did not match the API contract.',
    requestId: context.requestId,
    data: { endpointId: context.endpointId, reason: errorMessage(cause) },
  };
}

export function responseEncodingFailed(context: ApiRouteContext, cause: unknown): ApiError {
  return {
    code: 'api_response_encoding_failed',
    status: 500,
    message: 'Runtime response did not match the API contract.',
    requestId: context.requestId,
    data: { endpointId: context.endpointId, reason: errorMessage(cause) },
  };
}

export function unhandledApiError(context: ApiRouteContext, cause: unknown): ApiError {
  return {
    code: 'api_unhandled_error',
    status: 500,
    message: errorMessage(cause),
    requestId: context.requestId,
    data: { endpointId: context.endpointId },
  };
}

export function sendApiError(reply: FastifyReply, error: ApiError) {
  return reply.status(error.status).send({ error });
}

export function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error) {
    return error;
  }
  return 'Unhandled runtime error';
}
