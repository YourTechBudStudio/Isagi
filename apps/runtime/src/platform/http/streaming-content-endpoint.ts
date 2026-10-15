import { Effect, Exit, Pull, Scope, Stream } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiBasePath, type AnyApiContentEndpoint } from '@isagi/contracts';

import { runRoute, type ApiHandler, type Rejection } from './endpoint.js';
import { sendApiError, unhandledApiError, type ApiRouteContext } from './errors.js';
import { streamToReadable } from './readable-stream.js';
import { runRouteRequest, type RouteRuntime } from './route-runtime.js';

/** Bytes of unknown length, produced while they are sent (for example synthesized audio). */
export interface StreamingContent<E> {
  readonly mediaType: string;
  readonly stream: Stream.Stream<Uint8Array, E>;
}

export interface RegisterStreamingContentEndpointOptions<
  Endpoint extends AnyApiContentEndpoint,
  E,
> {
  /** The declared rejection for a stream that fails before its first byte. */
  readonly beforeFirstChunk: (error: E) => Rejection<Endpoint>;
}

/**
 * Content routes whose bytes are produced while they are sent, with no `Content-Length`.
 *
 * `registerContentEndpoint` needs a finished length. Here the stream is opened, and its first chunk
 * pulled, inside the route lifecycle: a failure that early is still an honest JSON error with its
 * declared status. Only after that chunk does the route commit a 200.
 *
 * The opened stream holds resources (a speech request, say) in a scope this registrar owns. Until
 * the first chunk arrives that scope is closed on every way out: a failure, a defect, or the
 * client's disconnect interrupting the request. After it, the scope passes to the pump, which
 * closes it when the body ends, fails, or the reader leaves. A failure past the first byte destroys
 * the response, so a truncated body never looks complete.
 */
export function registerStreamingContentEndpoint<Endpoint extends AnyApiContentEndpoint, E, R>(
  fastify: FastifyInstance,
  runtime: RouteRuntime<R>,
  endpoint: Endpoint,
  handle: ApiHandler<Endpoint, StreamingContent<E>, NoInfer<R>>,
  options: RegisterStreamingContentEndpointOptions<Endpoint, E>,
) {
  fastify.route({
    method: endpoint.method,
    url: `${apiBasePath}${endpoint.path}`,
    handler: async (request, reply) => {
      const context: ApiRouteContext = { endpointId: endpoint.id, requestId: String(request.id) };
      // Owned here rather than inside the request fiber, so whatever ends that fiber, the code
      // below still holds the scope and can close it.
      const scope = Scope.makeUnsafe();
      const release = () => runtime.runFork(Scope.close(scope, Exit.void));
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
            Effect.gen(function* () {
              const content = yield* handle(decoded);
              const opened = yield* openStream(content.stream, scope).pipe(
                Effect.catch((error) => decoded.reject(options.beforeFirstChunk(error))),
              );
              return { mediaType: content.mediaType, ...opened };
            }),
        ),
        (outcome) => (outcome._tag === 'Succeeded' ? 'succeeded' : outcome.outcome),
      );
      if (result._tag === 'Rejected') {
        release();
        if (result.clientGone) return;
        return sendApiError(reply, unhandledApiError(context, result.cause));
      }
      const outcome = result.value;
      if (outcome._tag === 'Failed') {
        release();
        if (result.clientGone) return;
        return sendApiError(reply, outcome.error);
      }
      if (result.clientGone) {
        release();
        return;
      }

      const { mediaType, first, rest } = outcome.value;
      const body = Stream.fromArray(first).pipe(
        Stream.concat(rest),
        Stream.ensuring(Scope.close(scope, Exit.void)),
      );
      reply.header('Content-Type', mediaType);
      reply.header('Cache-Control', 'no-store');
      return reply.status(200).send(streamToReadable(runtime, body, context));
    },
  });
}

/**
 * Opens `stream` in `scope` and pulls its first chunk. Any non-success exit, interruption
 * included, closes the scope before it returns; success leaves it open for the pump.
 */
function openStream<E>(stream: Stream.Stream<Uint8Array, E>, scope: Scope.Closeable) {
  return Effect.gen(function* () {
    const pull = yield* Scope.provide(Stream.toPull(stream), scope);
    const first = yield* Pull.catchDone(
      Effect.map(pull, (chunk): ReadonlyArray<Uint8Array> => chunk),
      () => Effect.succeed<ReadonlyArray<Uint8Array>>([]),
    );
    const rest: Stream.Stream<Uint8Array, E> =
      first.length === 0 ? Stream.empty : Stream.fromPull(Effect.succeed(pull));
    return { first, rest };
  }).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit))));
}
