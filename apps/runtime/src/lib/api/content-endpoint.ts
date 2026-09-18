import type { Readable } from 'node:stream';

import { Effect, Either, Schema } from 'effect';
import type { FastifyInstance } from 'fastify';

import {
  apiBasePath,
  type ApiContentEndpoint,
  type ApiContentEndpointParams,
  type ApiContentEndpointQuery,
  type ApiError,
} from '@isagi/contracts';

import { logDiagnosticEvent } from '../../diagnostics/phase.js';
import { sendApiError, unhandledApiError, type ApiRouteContext } from './errors.js';
import {
  decodeParams,
  decodeQuery,
  logSlowApiRequest,
  requestInterruptSignal,
  sendRouteApiError,
  slowApiRequestThresholdMs,
} from './route-runtime.js';

/**
 * Routes whose success body is bytes.
 *
 * Everything before the first byte is the ordinary route lifecycle, shared with
 * `registerApiEndpoint` through `route-runtime.ts`: params and query are decoded against the
 * endpoint's own schemas, the handler runs under the request's interrupt signal, and a failure is
 * the same JSON error envelope every other route sends. A client can therefore rely on the envelope
 * for any non-200 status, which is the whole reason this is a declared endpoint kind rather than a
 * hand-rolled raw route.
 *
 * After the first byte there is no envelope left to send. A stream that fails there destroys the
 * reply and logs with the request id — the only honest option, because a truncated 200 that ended in
 * a 500 body would be indistinguishable from a corrupt file.
 */

/**
 * Structurally identical to `EvidenceContentResponse` in `workflows/read/projection.service.ts`,
 * which restates it rather than importing this module so the read layer stays free of HTTP. The two
 * must change together.
 */
export interface ContentResponse {
  readonly stream: Readable;
  readonly mediaType: string;
  readonly byteSize: number;
  /** Used only when the route asks for an attachment. `null` means "let the client decide". */
  readonly filename: string | null;
}

export interface RegisterContentEndpointOptions<
  Endpoint extends ApiContentEndpoint<
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext | undefined,
    Schema.Schema.AnyNoContext | undefined
  >,
  R,
> {
  readonly handle: (
    context: ApiRouteContext,
    params: ApiContentEndpointParams<Endpoint>,
    query: ApiContentEndpointQuery<Endpoint>,
  ) => Effect.Effect<ContentResponse, unknown, R>;
  /**
   * Whether this request asked for a download rather than an inline view.
   *
   * Supplied by the route rather than read here, so the spelling of the query parameter stays the
   * route's own contract and this registrar stays generic over any content route.
   */
  readonly attachment?: (query: ApiContentEndpointQuery<Endpoint>) => boolean;
  readonly mapError?: (error: unknown, context: ApiRouteContext) => ApiError;
  readonly run: <A>(
    effect: Effect.Effect<A, unknown, R>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) => Promise<A>;
}

export function registerContentEndpoint<
  Endpoint extends ApiContentEndpoint<
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext | undefined,
    Schema.Schema.AnyNoContext | undefined
  >,
  R = never,
>(
  fastify: FastifyInstance,
  endpoint: Endpoint,
  options: RegisterContentEndpointOptions<Endpoint, R>,
) {
  fastify.route({
    method: endpoint.method,
    url: `${apiBasePath}${endpoint.path}`,
    handler: async (request, reply) => {
      const context = {
        endpointId: endpoint.id,
        requestId: String(request.id),
      } satisfies ApiRouteContext;

      const params = decodeParams<ApiContentEndpointParams<Endpoint>>(
        endpoint,
        request.params,
        context,
      );
      if (params.status === 'failed') {
        return sendApiError(reply, params.error);
      }
      const query = decodeQuery<ApiContentEndpointQuery<Endpoint>>(
        endpoint,
        request.query,
        context,
      );
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

      let content: ContentResponse;
      try {
        const result = await options.run(
          Effect.either(options.handle(context, params.value, query.value)),
          { signal: interrupt.signal },
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
        content = result.right;
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
        return sendRouteApiError(
          request,
          reply,
          endpoint,
          context,
          unhandledApiError(context, error),
        );
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
        content.stream.destroy();
        return;
      }

      // Past this point a 200 is committed. A stream failure can no longer be reported as an error,
      // so the connection is severed and the diagnostic goes to the log with the request id.
      content.stream.once('error', (error: unknown) => {
        logDiagnosticEvent(
          'api.content_stream_failed',
          {
            endpointId: endpoint.id,
            requestId: context.requestId,
            method: request.method,
            url: request.url,
            error: error instanceof Error ? error.message : String(error),
          },
          'warn',
        );
        reply.raw.destroy();
      });

      reply.header('Content-Type', content.mediaType);
      reply.header('Content-Length', String(content.byteSize));
      // The bytes behind a reference are immutable by construction — the reference is their hash —
      // but they are one run's recorded content, so a shared cache must never hold them.
      reply.header('Cache-Control', 'private, immutable');
      if (options.attachment?.(query.value) === true && content.filename !== null) {
        reply.header('Content-Disposition', contentDisposition(content.filename));
      }
      return reply.status(200).send(content.stream);
    },
  });
}

/**
 * A single-line `attachment` header, whatever the filename came from.
 *
 * The name is derived from author-supplied text, so it crosses a trust boundary into a response
 * header. Quotes, backslashes and control characters — CR and LF above all — are removed rather
 * than escaped, which keeps the result unambiguously one header line and keeps it inside the
 * `quoted-string` grammar. Non-ASCII is already excluded upstream, so no RFC 5987 `filename*` form
 * is needed.
 */
function contentDisposition(filename: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed.
  const safe = filename.replace(/["\\]/g, '').replace(/[\u0000-\u001f\u007f]/g, '');
  return `attachment; filename="${safe.length > 0 ? safe : 'download'}"`;
}
