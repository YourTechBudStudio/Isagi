import { PassThrough, type Readable } from 'node:stream';

import { Cause, Effect, Exit, Stream } from 'effect';

import type { ApiRouteContext } from './errors.js';
import type { RouteRuntime } from './route-runtime.js';

/**
 * Runs `stream` into a Node `Readable` for `reply.send`, under the route runtime.
 *
 * Sending a `Readable` keeps the reply on Fastify's normal path, so its hooks (CORS above all)
 * still set headers. Writes respect backpressure. The pump ends with the stream, and stops when
 * the reader goes away: a client disconnect closes the readable, which interrupts the producer.
 * Server shutdown interrupts the pump, which destroys the readable so `server.close()` can finish.
 *
 * A clean end ends the readable. A failure, a defect or an interruption destroys it instead, so a
 * truncated body never looks complete; the failure is logged at `Debug` with identifiers only,
 * because a stream's error can carry text this codebase did not author.
 */
export function streamToReadable<E>(
  runtime: RouteRuntime<never>,
  stream: Stream.Stream<Uint8Array, E>,
  context: ApiRouteContext,
): Readable {
  const readable = new PassThrough();
  const write = (chunk: Uint8Array) =>
    Effect.callback<void>((resume) => {
      if (readable.destroyed) return resume(Effect.void);
      if (readable.write(chunk)) return resume(Effect.void);
      // Resumed by `drain`, or by `close` when the reader leaves while the buffer is full.
      const resumeOnce = () => {
        readable.off('drain', resumeOnce);
        readable.off('close', resumeOnce);
        resume(Effect.void);
      };
      readable.once('drain', resumeOnce);
      readable.once('close', resumeOnce);
      return Effect.sync(() => {
        readable.off('drain', resumeOnce);
        readable.off('close', resumeOnce);
      });
    });
  const readerGone = Effect.callback<void>((resume) => {
    if (readable.destroyed) return resume(Effect.void);
    const onClose = () => resume(Effect.void);
    readable.once('close', onClose);
    return Effect.sync(() => readable.off('close', onClose));
  });
  const pump = Stream.runForEach(stream, write).pipe(
    Effect.raceFirst(readerGone),
    Effect.onExit((exit) =>
      Effect.suspend(() => {
        if (readable.destroyed) return Effect.void;
        if (Exit.isSuccess(exit)) return Effect.sync(() => readable.end());
        if (Cause.hasInterruptsOnly(exit.cause)) return Effect.sync(() => readable.destroy());
        return Effect.logDebug('api.stream_failed').pipe(
          Effect.annotateLogs({ ...context }),
          Effect.andThen(Effect.sync(() => readable.destroy(new Error('Response stream failed')))),
        );
      }),
    ),
    Effect.ignore,
  );
  runtime.runFork(pump);
  return readable;
}
