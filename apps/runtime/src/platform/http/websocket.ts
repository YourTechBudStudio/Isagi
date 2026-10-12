import { Deferred, Effect, Exit, Queue, Stream, type Cause } from 'effect';

/** WebSocket `readyState` values (same numbers in `ws` and the WHATWG API). */
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/**
 * The part of a server-side `ws` socket (what `@fastify/websocket` hands a route) the runtime uses. Structural so
 * tests can drive the adapter with an `EventEmitter`.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'message', listener: (raw: Buffer) => void): unknown;
  once(event: 'close', listener: () => void): unknown;
  off(event: 'message', listener: (raw: Buffer) => void): unknown;
  off(event: 'close', listener: () => void): unknown;
}

/** A WebSocket adapted once into Effect values; every socket callback ends in a queue or a deferred. */
export interface WsConnection {
  /** Text frames from the client, in arrival order. Ends when `closed` completes. */
  readonly incoming: Stream.Stream<string>;
  /** Sends `JSON.stringify(message)`; a no-op unless the socket is open. */
  readonly send: (message: unknown) => Effect.Effect<void>;
  /**
   * Closes the socket unless it is already closing or closed, and completes `closed` at once: the
   * server is done with the connection, so it does not wait for the client to finish the close
   * handshake (or for `ws`'s 30 s close timeout when the client never answers).
   */
  readonly close: Effect.Effect<void>;
  /**
   * Completes when the client closes the socket, when `close` runs, or when the connection's scope
   * closes, whichever is first. A route that waits on it therefore ends, and releases what its scope
   * holds, as soon as either side closes.
   */
  readonly closed: Effect.Effect<void>;
}

/**
 * Adapts a socket for the lifetime of the caller's scope. Listeners are attached synchronously when the effect runs,
 * so a route that starts this effect from its handler sees every frame. Closing the scope removes the listeners and
 * closes the socket if it is still open; route fibers therefore close their socket on interruption (server shutdown)
 * without any extra bookkeeping.
 */
export const acquireWsConnection = Effect.fn('http.acquireWsConnection')(function* (
  socket: WebSocketLike,
) {
  const incoming = yield* Queue.unbounded<string, Cause.Done>();
  const closed = yield* Deferred.make<void>();
  const onMessage = (raw: Buffer) => {
    Queue.offerUnsafe(incoming, raw.toString());
  };
  const onClose = () => {
    Queue.endUnsafe(incoming);
    Deferred.doneUnsafe(closed, Exit.void);
  };
  const close = Effect.sync(() => {
    if (socket.readyState !== CLOSING && socket.readyState !== CLOSED) socket.close();
    // `ws` emits `close` only once the handshake ends; the connection is over now.
    onClose();
  });

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      socket.on('message', onMessage);
      socket.once('close', onClose);
      // A socket that closed before the route ran never emits `close` again.
      if (socket.readyState === CLOSED) onClose();
    }),
    () =>
      Effect.sync(() => {
        socket.off('message', onMessage);
        socket.off('close', onClose);
      }).pipe(Effect.andThen(close)),
  );

  return {
    incoming: Stream.fromQueue(incoming),
    send: (message) =>
      Effect.sync(() => {
        if (socket.readyState === OPEN) socket.send(JSON.stringify(message));
      }),
    close,
    closed: Deferred.await(closed),
  } satisfies WsConnection;
});
