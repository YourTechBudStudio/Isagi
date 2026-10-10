import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';

import websocket from '@fastify/websocket';
import { Deferred, Effect, Fiber, Stream, type Scope } from 'effect';
import Fastify from 'fastify';

import { runScoped } from '@isagi/testing';

import { acquireWsConnection, type WsConnection } from './websocket.js';

/** The `ws` surface the adapter uses, driven by hand. `close()` behaves like ws: it emits `close` once. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly sent: string[] = [];
  closeCalls = 0;

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closeCalls++;
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit('close');
  }

  /** The client went away (no server-side `close()` call). */
  dropByClient() {
    this.readyState = 3;
    this.emit('close');
  }

  receive(text: string) {
    this.emit('message', Buffer.from(text));
  }
}

describe('acquireWsConnection with a fake socket', () => {
  test('incoming yields text frames in order and ends when the socket closes', async () => {
    const socket = new FakeSocket();
    const frames = await runScoped(
      Effect.gen(function* () {
        const connection = yield* acquireWsConnection(socket);
        socket.receive('one');
        socket.receive('two');
        socket.dropByClient();
        return yield* Stream.runCollect(connection.incoming);
      }),
    );
    assert.deepEqual(frames, ['one', 'two']);
  });

  test('send writes JSON only while the socket is open', async () => {
    const socket = new FakeSocket();
    await runScoped(
      Effect.gen(function* () {
        const connection = yield* acquireWsConnection(socket);
        yield* connection.send({ type: 'output', data: 'a' });
        socket.readyState = 2;
        yield* connection.send({ type: 'output', data: 'b' });
      }),
    );
    assert.deepEqual(socket.sent, ['{"type":"output","data":"a"}']);
  });

  test('closed completes when the client closes the socket', async () => {
    const socket = new FakeSocket();
    await runScoped(
      Effect.gen(function* () {
        const connection = yield* acquireWsConnection(socket);
        const waiter = yield* Effect.forkChild(connection.closed);
        yield* Effect.yieldNow;
        assert.equal(waiter.pollUnsafe(), undefined);
        socket.dropByClient();
        yield* Fiber.join(waiter);
      }),
    );
  });

  test('close closes an open socket once and is a no-op afterwards', async () => {
    const socket = new FakeSocket();
    await runScoped(
      Effect.gen(function* () {
        const connection = yield* acquireWsConnection(socket);
        yield* connection.close;
        yield* connection.closed;
        yield* connection.close;
      }),
    );
    assert.equal(socket.closeCalls, 1);
  });

  test('closing the scope removes the listeners and closes the socket', async () => {
    const socket = new FakeSocket();
    let connection: WsConnection | undefined;
    await runScoped(
      Effect.gen(function* () {
        connection = yield* acquireWsConnection(socket);
        assert.equal(socket.listenerCount('message'), 1);
        assert.equal(socket.listenerCount('close'), 1);
      }),
    );
    assert.equal(socket.listenerCount('message'), 0);
    assert.equal(socket.listenerCount('close'), 0);
    assert.equal(socket.closeCalls, 1);
    assert.equal(socket.readyState, 3);
    // Anything still waiting on the connection is released with the scope.
    await Effect.runPromise(connection!.closed);
  });

  test('a socket that closed before the connection was acquired completes closed immediately', async () => {
    const socket = new FakeSocket();
    socket.readyState = 3;
    const frames = await runScoped(
      Effect.gen(function* () {
        const connection = yield* acquireWsConnection(socket);
        yield* connection.closed;
        return yield* Stream.runCollect(connection.incoming);
      }),
    );
    assert.deepEqual(frames, []);
    assert.equal(socket.closeCalls, 0);
  });
});

describe('acquireWsConnection on a real @fastify/websocket socket', () => {
  /** Starts Fastify with one WebSocket route whose connection runs `program` in its own fiber. */
  const withServer = async (
    program: (connection: WsConnection) => Effect.Effect<void, never, Scope.Scope>,
    body: (input: {
      readonly url: string;
      readonly connections: Array<Fiber.Fiber<void>>;
    }) => Promise<void>,
  ) => {
    const fastify = Fastify({ logger: false });
    const connections: Array<Fiber.Fiber<void>> = [];
    await fastify.register(websocket);
    fastify.get('/socket', { websocket: true }, (socket) => {
      // `socket` is the real `ws` WebSocket type: this line is also the compile-time proof that it fits.
      connections.push(
        Effect.runFork(Effect.scoped(Effect.flatMap(acquireWsConnection(socket), program))),
      );
    });
    const address = await fastify.listen({ host: '127.0.0.1', port: 0 });
    try {
      await body({ url: `${address.replace('http', 'ws')}/socket`, connections });
    } finally {
      await Promise.all(connections.map((fiber) => Effect.runPromise(Fiber.interrupt(fiber))));
      await fastify.close();
    }
  };

  const open = (url: string) =>
    new Promise<{
      readonly client: WebSocket;
      readonly received: string[];
      readonly closed: Promise<void>;
    }>((resolve, reject) => {
      const client = new WebSocket(url);
      const received: string[] = [];
      const closed = new Promise<void>((done) => client.addEventListener('close', () => done()));
      client.addEventListener('message', (event) => received.push(String(event.data)));
      client.addEventListener('open', () => resolve({ client, received, closed }), { once: true });
      client.addEventListener('error', () => reject(new Error('WebSocket failed to open')), {
        once: true,
      });
    });

  const waitUntil = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(condition(), 'condition not reached in time');
  };

  test('client frames arrive in order, replies reach the client, and a client close ends the connection', async () => {
    const ended: string[] = [];
    await withServer(
      (connection) =>
        Effect.gen(function* () {
          yield* connection.incoming.pipe(
            Stream.runForEach((text) => connection.send({ echo: text })),
            Effect.forkScoped,
          );
          yield* connection.closed;
          ended.push('closed');
        }),
      async ({ url, connections }) => {
        const { client, received } = await open(url);
        client.send('a');
        client.send('b');
        await waitUntil(() => received.length === 2);
        assert.deepEqual(received, ['{"echo":"a"}', '{"echo":"b"}']);

        client.close();
        await waitUntil(() => ended.length === 1);
        await waitUntil(() => connections.length === 1);
        await Effect.runPromise(Fiber.await(connections[0]!));
      },
    );
    assert.deepEqual(ended, ['closed']);
  });

  test('interrupting the connection fiber closes the client socket', async () => {
    await withServer(
      (connection) => Effect.andThen(connection.send({ type: 'hello' }), Effect.never),
      async ({ url, connections }) => {
        const { received, closed } = await open(url);
        await waitUntil(() => received.length === 1 && connections.length === 1);

        await Effect.runPromise(Fiber.interrupt(connections[0]!));

        await closed;
        assert.deepEqual(received, ['{"type":"hello"}']);
      },
    );
  });

  test('the server closing the connection is observed through closed', async () => {
    await withServer(
      (connection) =>
        Effect.gen(function* () {
          const done = yield* Deferred.make<void>();
          yield* connection.closed.pipe(
            Effect.andThen(Deferred.succeed(done, undefined)),
            Effect.forkScoped,
          );
          yield* connection.close;
          yield* Deferred.await(done);
        }),
      async ({ url, connections }) => {
        const { closed } = await open(url);
        await closed;
        await waitUntil(() => connections.length === 1);
        await Effect.runPromise(Fiber.await(connections[0]!));
      },
    );
  });
});
