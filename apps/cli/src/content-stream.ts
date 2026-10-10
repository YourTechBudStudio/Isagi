import { Data, Effect, Stream } from 'effect';

/**
 * A content stream that stopped part-way, with the side that actually failed.
 *
 * `source` is the runtime's response body breaking; `destination` is the local write (stdout)
 * failing. Each calls for different recovery, so they must not be confused.
 */
export class ContentStreamFailure extends Data.TaggedError('ContentStreamFailure')<{
  readonly side: 'source' | 'destination';
  readonly cause: unknown;
}> {}

/**
 * Writes every chunk of `source` into `destination` and returns the byte count written. The
 * destination is not ended: stdout belongs to the process.
 *
 * Each side fails through its own channel, so there is no race over which failure came first: a
 * source failure arrives on the stream's error channel, a destination failure through a write's
 * callback (or an `error` event seen before the next write). Each write waits for its callback, so a
 * slow reader holds the download back. When a write fails the stream is interrupted, which cancels
 * the response body.
 */
export const streamContent = Effect.fnUntraced(function* <E>(
  source: Stream.Stream<Uint8Array, E>,
  destination: NodeJS.WritableStream,
) {
  // A failed write emits `error` *after* its callback, and an `error` event with no listener crashes
  // Node (EPIPE on a closed stdout). So this listener is never removed: it must outlive the transfer.
  let destinationError: unknown;
  yield* Effect.sync(() =>
    destination.on('error', (cause) => {
      destinationError ??= cause;
    }),
  );

  const write = (chunk: Uint8Array) =>
    Effect.callback<void, ContentStreamFailure>((resume) => {
      if (destinationError !== undefined) {
        resume(
          Effect.fail(new ContentStreamFailure({ side: 'destination', cause: destinationError })),
        );
        return;
      }
      destination.write(chunk, (error) =>
        resume(
          error
            ? Effect.fail(new ContentStreamFailure({ side: 'destination', cause: error }))
            : Effect.void,
        ),
      );
    });

  let written = 0;
  yield* source.pipe(
    Stream.mapError((cause) => new ContentStreamFailure({ side: 'source', cause })),
    Stream.runForEach((chunk) =>
      Effect.map(write(chunk), () => {
        written += chunk.byteLength;
      }),
    ),
  );
  return written;
});
