import type { Readable } from 'node:stream';

import { Effect } from 'effect';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  apiBasePath,
  type AnyApiContentEndpoint,
  type ApiContentEndpointQuery,
} from '@isagi/contracts';

import { runRoute, type ApiHandler } from './endpoint.js';
import { sendApiError, unhandledApiError, type ApiRouteContext } from './errors.js';
import { runRouteRequest, watchContentStream, type RouteRuntime } from './route-runtime.js';

/**
 * Routes whose success body is bytes.
 *
 * Everything before the first byte is the ordinary route lifecycle, shared with
 * `registerApiEndpoint` through `runRoute`: params and query are decoded against the
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
 * Structurally identical to `WorkflowContentResponse` in `workflows/read/projection.service.ts`,
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

export interface RegisterContentEndpointOptions<Endpoint extends AnyApiContentEndpoint> {
  /**
   * Whether this request asked for a download rather than an inline view.
   *
   * Supplied by the route rather than read here, so the spelling of the query parameter stays the
   * route's own contract and this registrar stays generic over any content route.
   */
  readonly attachment?: (query: ApiContentEndpointQuery<Endpoint>) => boolean;
}

export function registerContentEndpoint<Endpoint extends AnyApiContentEndpoint, R>(
  fastify: FastifyInstance,
  runtime: RouteRuntime<R>,
  endpoint: Endpoint,
  handle: ApiHandler<Endpoint, ContentResponse, NoInfer<R>>,
  options: RegisterContentEndpointOptions<Endpoint> = {},
) {
  fastify.route({
    method: endpoint.method,
    url: `${apiBasePath}${endpoint.path}`,
    handler: async (request, reply) => {
      const context: ApiRouteContext = { endpointId: endpoint.id, requestId: String(request.id) };
      const result = await runRouteRequest(
        runtime,
        request,
        reply,
        context,
        runRoute(
          endpoint,
          {
            requestId: context.requestId,
            body: undefined,
            params: request.params,
            query: request.query,
          },
          (decoded) =>
            Effect.map(handle(decoded), (content) => ({
              content,
              attachment: options.attachment?.(decoded.query) === true,
            })),
        ),
        (outcome) => (outcome._tag === 'Succeeded' ? 'succeeded' : outcome.outcome),
      );
      if (result._tag === 'Rejected') {
        if (result.clientGone) return;
        return sendApiError(reply, unhandledApiError(context, result.cause));
      }
      const outcome = result.value;
      if (outcome._tag === 'Failed') {
        if (result.clientGone) return;
        return sendApiError(reply, outcome.error);
      }
      const { content, attachment } = outcome.value;
      return sendContent(runtime, request, reply, context, content, attachment, result.clientGone);
    },
  });
}

/**
 * Sends a content route's bytes, or releases the stream when the client already left. Past this point a 200 is
 * committed: a stream failure severs the connection and is logged with the request id.
 */
export function sendContent<R>(
  runtime: RouteRuntime<R>,
  request: FastifyRequest,
  reply: FastifyReply,
  context: ApiRouteContext,
  content: ContentResponse,
  attachment: boolean,
  clientGone: boolean,
) {
  if (clientGone) {
    content.stream.destroy();
    return;
  }

  watchContentStream(runtime, request, reply, context, content.stream);

  reply.header('Content-Type', content.mediaType);
  reply.header('Content-Length', String(content.byteSize));
  // The bytes behind a reference are immutable by construction — the reference is their hash —
  // but they are one run's recorded content, so a shared cache must never hold them.
  reply.header('Cache-Control', 'private, immutable');
  if (attachment && content.filename !== null) {
    reply.header('Content-Disposition', contentDisposition(content.filename));
  }
  return reply.status(200).send(content.stream);
}

/**
 * A single-line `attachment` header, whatever the filename came from.
 *
 * The name is derived from author- or workspace-supplied text, so it crosses a trust boundary into
 * a response header. Quotes, backslashes and control characters — CR and LF above all — are removed
 * rather than escaped, which keeps the result unambiguously one header line and keeps it inside the
 * `quoted-string` grammar.
 *
 * An ASCII name is sent exactly as `filename="…"`. A name with anything else (a checkpoint file
 * keeps its real basename, which may be any Unicode) also carries RFC 6266's `filename*` with the
 * UTF-8 bytes percent-encoded, and its `filename` becomes an ASCII fallback with each non-ASCII
 * character replaced by `_`. Node refuses a header value outside Latin-1, so sending the raw name
 * would fail the response rather than merely garble it.
 */
export function contentDisposition(filename: string): string {
  // Well-formed first, so a lone surrogate cannot make the UTF-8 encoding below throw.
  const safe = filename
    .toWellFormed()
    .replace(/["\\]/g, '')
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed.
    .replace(/[\u0000-\u001f\u007f]/g, '');
  const ascii = safe.replace(/[^\u0020-\u007e]/gu, '_');
  const fallback = `attachment; filename="${ascii.length > 0 ? ascii : 'download'}"`;
  if (ascii === safe) return fallback;
  return `${fallback}; filename*=UTF-8''${encodeRfc5987(safe)}`;
}

/** `attr-char` from RFC 5987: everything else, including `'`, `(`, `)` and `*`, is percent-encoded. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
