import { Readable, type Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { Data, Effect } from 'effect';

/**
 * A content stream that stopped part-way, with the side that actually failed.
 *
 * `source` is the runtime's response body breaking; `destination` is the local write (a file, or
 * stdout) failing; `transform` is the caller's own check between them refusing the bytes (for
 * example an integrity check). Each calls for different recovery, so they must not be confused.
 */
export class ContentStreamFailure extends Data.TaggedError('ContentStreamFailure')<{
  readonly side: 'source' | 'transform' | 'destination';
  readonly cause: unknown;
}> {}

/**
 * Streams a content response body into `destination` and returns the byte count written.
 *
 * `through`, when given, sits between the two and sees every byte; an error it raises is reported
 * as the `transform` side.
 *
 * `pipeline` tears down every stream once one fails and rejects with whichever error it saw first,
 * so neither its rejection nor "which stream emitted an error" says where the failure began: a
 * broken download also destroys the file stream, and a failed write also destroys the download.
 * The first `error` event does. These listeners are attached before `pipeline` attaches its own,
 * so they observe the original failure before the teardown it causes.
 */
export function streamContent(
  body: ReadableStream<Uint8Array> | null,
  destination: NodeJS.WritableStream,
  options: { readonly end: boolean; readonly through?: Transform },
): Effect.Effect<number, ContentStreamFailure> {
  if (body === null) {
    return streamContent(emptyBody(), destination, options);
  }
  return Effect.suspend(() => {
    const source = Readable.fromWeb(body as NodeReadableStream);
    let first: ContentStreamFailure | undefined;
    source.once('error', (cause) => {
      first ??= new ContentStreamFailure({ side: 'source', cause });
    });
    options.through?.once('error', (cause) => {
      first ??= new ContentStreamFailure({ side: 'transform', cause });
    });
    destination.once('error', (cause) => {
      first ??= new ContentStreamFailure({ side: 'destination', cause });
    });

    let written = 0;
    const counted = async function* (chunks: AsyncIterable<Uint8Array>) {
      for await (const chunk of chunks) {
        written += chunk.byteLength;
        yield chunk;
      }
    };
    return Effect.tryPromise({
      // The signal aborts the streams when the effect is interrupted (a sibling write failed), so
      // an abandoned transfer stops rather than writing on into a file that is being removed.
      try: (signal) =>
        options.through
          ? pipeline(source, counted, options.through, destination, { end: options.end, signal })
          : pipeline(source, counted, destination, { end: options.end, signal }),
      // No stream emitted: the failure was in the byte counter, which only writing can cause here.
      catch: (cause) => first ?? new ContentStreamFailure({ side: 'destination', cause }),
    }).pipe(Effect.map(() => written));
  });
}

/** An empty body still runs the whole pipeline, so a `through` check sees its end. */
function emptyBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}
