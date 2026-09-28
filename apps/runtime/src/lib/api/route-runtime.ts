import { Schema } from 'effect';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { apiInfrastructureErrorSchema, type ApiError } from '@isagi/contracts';

import { logDiagnosticEvent } from '../../diagnostics/phase.js';
import {
  requestDecodingFailed,
  responseEncodingFailed,
  sendApiError,
  type ApiRouteContext,
} from './errors.js';

/**
 * What every registered route does the same way, whatever its response body is.
 *
 * Two registrars sit on top of this: `registerApiEndpoint`, whose success body is the JSON envelope,
 * and `registerContentEndpoint`, whose success body is bytes. They differ only in how they finish a
 * successful request — request decoding, the interrupt signal, the slow-request log and error
 * encoding are identical, and a second copy of any of them would be the drift this module exists to
 * prevent. It is internal to `lib/api`; nothing outside it imports from here.
 *
 * Endpoint descriptors are accepted structurally rather than by their generic types, because the two
 * descriptor kinds share only these fields — the alternative is a union that neither registrar's own
 * inference can see through.
 */

export const slowApiRequestThresholdMs = 1_000;

/** The slots of a descriptor this module actually reads. */
export interface RouteDescriptor {
  readonly id: string;
  readonly params?: unknown;
  readonly query?: unknown;
  readonly errors: unknown;
}

export type Decoded<Value> =
  | { readonly status: 'succeeded'; readonly value: Value }
  | { readonly status: 'failed'; readonly error: ApiError };

export function decodeParams<Value>(
  endpoint: RouteDescriptor,
  params: unknown,
  context: ApiRouteContext,
): Decoded<Value> {
  return decodeWith<Value>(endpoint.params, params, context);
}

export function decodeQuery<Value>(
  endpoint: RouteDescriptor,
  query: unknown,
  context: ApiRouteContext,
): Decoded<Value> {
  return decodeWith<Value>(endpoint.query, query, context);
}

function decodeWith<Value>(
  schema: unknown,
  value: unknown,
  context: ApiRouteContext,
): Decoded<Value> {
  const decoder = schema as Schema.Schema.AnyNoContext | undefined;
  if (!decoder) {
    return { status: 'succeeded', value: undefined as Value };
  }
  try {
    return {
      status: 'succeeded',
      value: Schema.decodeUnknownSync(decoder)(coerceRouteParams(value)) as Value,
    };
  } catch (error: unknown) {
    return { status: 'failed', error: requestDecodingFailed(context, error) };
  }
}

/**
 * Numeric-looking path and query values arrive as strings; schemas declare them as numbers.
 *
 * Only top-level string entries are coerced, so a repeated query parameter — which Fastify hands
 * over as an array — passes through untouched and is normalised by its own schema instead.
 */
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

export interface RequestInterrupt {
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
}

export function requestInterruptSignal(
  request: FastifyRequest,
  reply: FastifyReply,
): RequestInterrupt {
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

export function logSlowApiRequest(input: {
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

/**
 * Sends an error against the schema the endpoint actually declares, so a route can never emit a
 * rejection its own contract does not describe.
 */
export function sendRouteApiError(
  request: FastifyRequest,
  reply: FastifyReply,
  endpoint: RouteDescriptor,
  context: ApiRouteContext,
  apiError: ApiError,
) {
  const errorSchema = apiError.code.startsWith('api_')
    ? apiInfrastructureErrorSchema
    : (endpoint.errors as Schema.Schema.AnyNoContext);

  try {
    Schema.decodeUnknownSync(errorSchema)(apiError);
    return sendApiError(reply, apiError);
  } catch (error: unknown) {
    request.log.error({ error, endpointId: endpoint.id }, 'API error encoding failed');
    return sendApiError(reply, responseEncodingFailed(context, error));
  }
}
