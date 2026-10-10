import type { Readable } from 'node:stream';

import { Cause, Clock, Duration, Effect, Exit } from 'effect';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiRouteContext } from './errors.js';

/**
 * How a route reaches the runtime's services, and the one place a Fastify request becomes a fiber.
 *
 * A module's route registrar receives a `RouteRuntime<R>` typed by the services its own routes use, so it never
 * imports the composition root. The composition root hands every registrar the same runtime; a runtime that provides
 * more services is assignable to every narrower `RouteRuntime<R>`.
 *
 * Every Effect a route runs goes through `runRouteRequest` or `watchContentStream` below, so this file is the single
 * run-site boundary for HTTP routes. WebSocket routes run their connection effects on the same runtime.
 */
export interface RouteRuntime<R> {
  /**
   * Runs `effect` on the server's runtime; aborting `signal` interrupts it. Rejects with the squashed failure, which
   * for HTTP routes (whose pipeline never fails) can only mean interruption.
   */
  readonly runPromise: <A, E = never>(
    effect: Effect.Effect<A, E, R>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) => Promise<A>;
  /** Forks `effect` on the server's runtime; shutdown interrupts it. */
  readonly runFork: (effect: Effect.Effect<void, never, R>) => void;
}

/** A request taking at least this long is reported at `Debug` (`ISAGI_RUNTIME_DEBUG`). */
export const slowApiRequestThreshold = Duration.seconds(1);

/** What a request ended as, for the slow-request diagnostics. */
export type RouteRequestOutcome = 'aborted' | 'failed' | 'succeeded' | 'threw';

/**
 * How `runRouteRequest` ended: with the pipeline's value, or with the run's rejection (for a pipeline that never fails,
 * an interruption). `clientGone` means the client disconnected or the response was destroyed, so nothing may be sent.
 */
export type RouteRequestResult<A> =
  | { readonly _tag: 'Completed'; readonly value: A; readonly clientGone: boolean }
  | { readonly _tag: 'Rejected'; readonly cause: unknown; readonly clientGone: boolean };

/**
 * Runs one request's pipeline under the request's interrupt signal: a client that disconnects, or a request or socket
 * timeout, interrupts the fiber. The pipeline is annotated with the endpoint and request ids and reports slow requests
 * at `Debug`.
 *
 * A `Rejected` request whose client is still there was interrupted by the runtime itself (for example at shutdown),
 * and the caller still owes the client an answer.
 */
export async function runRouteRequest<A, R>(
  runtime: RouteRuntime<R>,
  request: FastifyRequest,
  reply: FastifyReply,
  context: ApiRouteContext,
  pipeline: Effect.Effect<A, never, R>,
  outcomeOf: (value: A) => Exclude<RouteRequestOutcome, 'aborted'>,
): Promise<RouteRequestResult<A>> {
  const interrupt = requestInterruptSignal(request, reply);
  const clientGone = () => interrupt.signal.aborted || reply.raw.destroyed;
  try {
    const value = await runtime.runPromise(
      withRequestDiagnostics(request, context, pipeline, outcomeOf),
      { signal: interrupt.signal },
    );
    return { _tag: 'Completed', value, clientGone: clientGone() };
  } catch (cause: unknown) {
    return { _tag: 'Rejected', cause, clientGone: clientGone() };
  } finally {
    interrupt.cleanup();
  }
}

/**
 * After a content route committed its 200, a failing stream can no longer be reported as an error: the connection is
 * severed, and the diagnostic is the only record of the failure, logged with the request id.
 */
export function watchContentStream<R>(
  runtime: RouteRuntime<R>,
  request: FastifyRequest,
  reply: FastifyReply,
  context: ApiRouteContext,
  stream: Readable,
) {
  stream.once('error', (error: unknown) => {
    runtime.runFork(
      Effect.logDebug('api.content_stream_failed').pipe(
        Effect.annotateLogs({
          ...context,
          method: request.method,
          url: request.url,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
    reply.raw.destroy();
  });
}

function withRequestDiagnostics<A, R>(
  request: FastifyRequest,
  context: ApiRouteContext,
  pipeline: Effect.Effect<A, never, R>,
  outcomeOf: (value: A) => Exclude<RouteRequestOutcome, 'aborted'>,
): Effect.Effect<A, never, R> {
  const thresholdMs = Duration.toMillis(slowApiRequestThreshold);
  const requestLine = { method: request.method, url: request.url };
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const elapsedMs = Effect.map(Clock.currentTimeMillis, (now) => now - startedAt);
    // A child fiber, so it is interrupted when the request finishes first.
    yield* Effect.forkChild(
      Effect.flatMap(elapsedMs, (elapsed) =>
        Effect.logDebug('api.request_still_running').pipe(
          Effect.annotateLogs({ ...requestLine, elapsedMs: elapsed }),
        ),
      ).pipe(Effect.delay(slowApiRequestThreshold)),
    );
    return yield* Effect.onExit(pipeline, (exit) =>
      Effect.flatMap(elapsedMs, (elapsed) =>
        elapsed < thresholdMs
          ? Effect.void
          : Effect.logDebug('api.request_completed').pipe(
              Effect.annotateLogs({
                ...requestLine,
                outcome: Exit.isSuccess(exit)
                  ? outcomeOf(exit.value)
                  : Cause.hasInterruptsOnly(exit.cause)
                    ? 'aborted'
                    : 'threw',
                elapsedMs: elapsed,
              }),
            ),
      ),
    );
  }).pipe(Effect.annotateLogs({ ...context }));
}

/**
 * Numeric-looking path and query values arrive as strings; schemas declare them as numbers.
 *
 * Only top-level string entries are coerced, so a repeated query parameter — which Fastify hands
 * over as an array — passes through untouched and is normalised by its own schema instead.
 */
export function coerceRouteParams(params: unknown) {
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

interface RequestInterrupt {
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
}

function requestInterruptSignal(request: FastifyRequest, reply: FastifyReply): RequestInterrupt {
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
