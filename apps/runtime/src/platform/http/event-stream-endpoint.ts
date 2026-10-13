import { Duration, Stream } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiBasePath, type AnyApiEventStreamEndpoint } from '@isagi/contracts';

import { runRoute, type ApiHandler } from './endpoint.js';
import { sendApiError, unhandledApiError, type ApiRouteContext } from './errors.js';
import { streamToReadable } from './readable-stream.js';
import { runRouteRequest, type RouteRuntime } from './route-runtime.js';

/** Long enough to be cheap, short enough that proxies and idle sockets keep the stream open. */
export const eventStreamHeartbeatInterval = Duration.seconds(15);

export interface RegisterEventStreamEndpointOptions {
  /** Default `eventStreamHeartbeatInterval`; tests shorten it. */
  readonly heartbeatInterval?: Duration.Input;
}

const encoder = new TextEncoder();

/**
 * Server-sent event routes.
 *
 * Everything before the stream opens is the ordinary route lifecycle, shared with the other
 * endpoint kinds through `runRoute`: params are decoded, the handler runs under the request's
 * interrupt signal, and a refusal (for example an unknown resource) is the JSON error envelope with
 * its declared status. Only a handler that succeeds opens the stream.
 *
 * The handler returns the items, each a JSON-encodable value its owner already encoded. The body
 * starts with a comment so the headers flush at once, carries each item as one `data:` event, and
 * interleaves heartbeat comments until the item stream ends. A client that disconnects interrupts
 * the item stream.
 */
export function registerEventStreamEndpoint<Endpoint extends AnyApiEventStreamEndpoint, R>(
  fastify: FastifyInstance,
  runtime: RouteRuntime<R>,
  endpoint: Endpoint,
  handle: ApiHandler<Endpoint, Stream.Stream<unknown>, NoInfer<R>>,
  options: RegisterEventStreamEndpointOptions = {},
) {
  const heartbeatInterval = options.heartbeatInterval ?? eventStreamHeartbeatInterval;
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
            query: undefined,
          },
          handle,
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
      // The item stream is lazy: a client that already left has started nothing to release.
      if (result.clientGone) return;

      const heartbeats = Stream.tick(heartbeatInterval).pipe(
        Stream.drop(1),
        Stream.map(() => ': heartbeat\n\n'),
      );
      const events = Stream.map(outcome.value, (item) => `data: ${JSON.stringify(item)}\n\n`);
      const body = Stream.make(': connected\n\n').pipe(
        Stream.concat(Stream.merge(events, heartbeats, { haltStrategy: 'left' })),
        Stream.map((text) => encoder.encode(text)),
      );

      reply.header('Content-Type', 'text/event-stream; charset=utf-8');
      reply.header('Cache-Control', 'no-store');
      // Proxies such as nginx otherwise buffer the stream.
      reply.header('X-Accel-Buffering', 'no');
      return reply.status(200).send(streamToReadable(runtime, body, context));
    },
  });
}
