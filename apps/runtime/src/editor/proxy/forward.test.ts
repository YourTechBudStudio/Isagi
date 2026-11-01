import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import test from 'node:test';

import websocket from '@fastify/websocket';
import { Effect, Layer, Logger, References, Schema } from 'effect';
import Fastify, { type FastifyInstance } from 'fastify';

import { editorProxyUnavailableErrorSchema } from '@isagi/contracts';

import type { RouteRuntime } from '../../platform/http/index.js';
import { withListeningServer, type ListeningServer } from '../../platform/http/testing.js';
import { EditorContextService } from '../contexts/service.js';
import { proxyExchange } from './forward.js';
import { registerEditorProxy } from './route.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Targets = ReadonlyMap<number, { readonly host: string; readonly port: number }>;

function stubEditors(targets: Targets): EditorContextService['Service'] {
  const unused = (name: string) => () => Effect.die(`${name} is not used by proxy tests`);
  return {
    requireAvailable: Effect.die('requireAvailable is not used by proxy tests'),
    findForWorktree: unused('findForWorktree'),
    createForWorktree: unused('createForWorktree'),
    ensureRuntime: unused('ensureRuntime'),
    releaseIncarnation: unused('releaseIncarnation'),
    readinessFor: unused('readinessFor'),
    diagnostics: unused('diagnostics'),
    proxyTarget: (editorContextId) => Effect.succeed(targets.get(editorContextId) ?? null),
  };
}

interface LogEntry {
  readonly level: string;
  readonly message: unknown;
  readonly annotations: Record<string, unknown>;
}

interface Proxy extends ListeningServer {
  readonly port: number;
  readonly logs: LogEntry[];
  /** Resolves when the `n`th exchange fiber has ended; only for `observed` servers. */
  readonly exchangeEnded: (n?: number) => Promise<void>;
}

/**
 * The proxy on a real listening server over a stub editor service, with `@fastify/websocket` registered first as in
 * production. `observed` swaps the route registration for one that also reports when each exchange fiber ends, to
 * assert the lifecycle rule; everything else goes through `registerEditorProxy` itself.
 */
function withProxy<A>(
  targets: Targets,
  run: (proxy: Proxy) => Promise<A>,
  options: { readonly observed?: boolean } = {},
): Promise<A> {
  const logs: LogEntry[] = [];
  const logger = Logger.make((entry) => {
    logs.push({
      level: entry.logLevel,
      message: entry.message,
      annotations: { ...entry.fiber.getRef(References.CurrentLogAnnotations) },
    });
  });
  const ended: Array<() => void> = [];
  const endings: Promise<void>[] = [];
  const nextEnding = () => {
    endings.push(new Promise<void>((resolve) => ended.push(resolve)));
  };
  for (let index = 0; index < 8; index += 1) nextEnding();
  let endedCount = 0;

  return withListeningServer(
    Layer.mergeAll(
      Layer.succeed(EditorContextService, stubEditors(targets)),
      Logger.layer([logger]),
    ),
    (fastify, runtime) => {
      void fastify.register(websocket);
      void fastify.register(async (instance) => {
        if (options.observed) {
          registerObservedProxy(instance, runtime, () => ended[endedCount++]?.());
        } else {
          registerEditorProxy(instance, runtime);
        }
      });
    },
    (server) =>
      run({
        ...server,
        port: Number(new URL(server.origin).port),
        logs,
        exchangeEnded: (n = 1) => within(endings[n - 1]!),
      }),
  );
}

function registerObservedProxy(
  fastify: FastifyInstance,
  runtime: RouteRuntime<EditorContextService>,
  onEnded: () => void,
) {
  const agent = new http.Agent({ keepAlive: true });
  fastify.addHook('onClose', (_instance, done) => {
    agent.destroy();
    done();
  });
  fastify.all(
    '/editor/:editorContextId/*',
    {
      onRequest: (request, reply, done) => {
        reply.hijack();
        runtime.runFork(
          proxyExchange({ request, reply, agent }).pipe(Effect.ensuring(Effect.sync(onEnded))),
        );
        done();
      },
    },
    () => undefined,
  );
}

/** A stub Code Server: plain `node:http`, with an optional raw `upgrade` handler. */
async function withUpstream<A>(
  handlers: {
    readonly request?: http.RequestListener;
    readonly upgrade?: (request: http.IncomingMessage, socket: Socket, head: Buffer) => void;
  },
  run: (target: { readonly host: string; readonly port: number }) => Promise<A>,
): Promise<A> {
  const server = http.createServer(
    handlers.request ??
      ((_request, response) => {
        response.end('ok');
      }),
  );
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  if (handlers.upgrade) server.on('upgrade', handlers.upgrade);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run({ host: '127.0.0.1', port: (server.address() as AddressInfo).port });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A stub Code Server that speaks WebSocket, for frame-level echo through the byte-level proxy. */
async function withWebSocketUpstream<A>(
  run: (target: { readonly host: string; readonly port: number }) => Promise<A>,
  onServerSocketClosed: () => void = () => undefined,
): Promise<A> {
  const upstream = Fastify({ logger: false });
  await upstream.register(websocket);
  upstream.get('/echo', { websocket: true }, (socket) => {
    socket.send(Buffer.from([0xde, 0xad]));
    socket.on('message', (data: Buffer, isBinary: boolean) =>
      socket.send(data, { binary: isBinary }),
    );
    socket.on('close', onServerSocketClosed);
  });
  const address = await upstream.listen({ host: '127.0.0.1', port: 0 });
  try {
    return await run({ host: '127.0.0.1', port: Number(new URL(address).port) });
  } finally {
    await upstream.close();
  }
}

interface SimpleResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
  readonly socket: Socket;
}

function send(
  port: number,
  path: string,
  options: {
    readonly method?: string;
    readonly headers?: http.OutgoingHttpHeaders;
    readonly body?: Buffer;
    readonly agent?: http.Agent | false;
  } = {},
): Promise<SimpleResponse> {
  return within(
    new Promise<SimpleResponse>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: options.method ?? 'GET',
          headers: options.headers,
          agent: options.agent ?? false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
              socket: response.socket,
            }),
          );
        },
      );
      request.on('error', reject);
      request.end(options.body);
    }),
  );
}

type UpgradeOutcome =
  | {
      readonly kind: 'upgraded';
      readonly response: http.IncomingMessage;
      readonly socket: Socket;
      readonly head: Buffer;
    }
  | { readonly kind: 'response'; readonly response: http.IncomingMessage; readonly body: Buffer };

function upgradeRequest(
  port: number,
  path: string,
  headers: http.OutgoingHttpHeaders = {},
): { readonly request: http.ClientRequest; readonly outcome: Promise<UpgradeOutcome> } {
  const request = http.request({
    host: '127.0.0.1',
    port,
    path,
    agent: false,
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': randomBytes(16).toString('base64'),
      ...headers,
    },
  });
  const outcome = new Promise<UpgradeOutcome>((resolve, reject) => {
    request.on('upgrade', (response, socket, head) =>
      resolve({ kind: 'upgraded', response, socket, head }),
    );
    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ kind: 'response', response, body: Buffer.concat(chunks) }),
      );
    });
    request.on('error', reject);
  });
  request.end();
  return { request, outcome: within(outcome) };
}

const decodeUnavailable = Schema.decodeUnknownSync(editorProxyUnavailableErrorSchema);

function unavailableBody(body: Buffer) {
  return decodeUnavailable((JSON.parse(body.toString('utf8')) as { error: unknown }).error);
}

const closed = (emitter: NodeJS.EventEmitter) =>
  within(new Promise<void>((resolve) => emitter.once('close', () => resolve())));

const within = <A>(promise: Promise<A>, ms = 3_000) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);

async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

test('HTTP: the prefix is stripped, the query kept, and Host, Origin and Cookie arrive unchanged', async () => {
  let seen: { url?: string | undefined; headers?: http.IncomingHttpHeaders } = {};
  await withUpstream(
    {
      request: (request, response) => {
        seen = { url: request.url, headers: request.headers };
        response.setHeader('set-cookie', ['a=1', 'b=2']);
        response.setHeader('x-upstream', 'yes');
        response.end('from code server');
      },
    },
    (target) =>
      withProxy(new Map([[7, target]]), async (proxy) => {
        const response = await send(proxy.port, '/editor/7/stable-abc/x%20y?y=1&z=%2F', {
          headers: {
            host: 'vm.tail.ts.net',
            origin: 'https://vm.tail.ts.net',
            cookie: 'session=abc; other=def',
            'x-forwarded-proto': 'https',
          },
        });
        assert.equal(response.status, 200);
        assert.equal(response.body.toString(), 'from code server');
        assert.equal(response.headers['x-upstream'], 'yes');
        assert.deepEqual(response.headers['set-cookie'], ['a=1', 'b=2']);
        assert.equal(response.headers['content-security-policy'], undefined);
      }),
  );
  assert.equal(seen.url, '/stable-abc/x%20y?y=1&z=%2F');
  assert.equal(seen.headers?.host, 'vm.tail.ts.net');
  assert.equal(seen.headers?.origin, 'https://vm.tail.ts.net');
  assert.equal(seen.headers?.cookie, 'session=abc; other=def');
  assert.equal(seen.headers?.['x-forwarded-proto'], 'https');
});

test('HTTP: a 1 MiB POST body with a non-JSON content type arrives intact', async () => {
  const body = randomBytes(1024 * 1024);
  let received: { length: number; hash: string; type: string | undefined } | undefined;
  await withUpstream(
    {
      request: (request, response) => {
        const hash = createHash('sha256');
        let length = 0;
        request.on('data', (chunk: Buffer) => {
          length += chunk.length;
          hash.update(chunk);
        });
        request.on('end', () => {
          received = { length, hash: hash.digest('hex'), type: request.headers['content-type'] };
          response.end('stored');
        });
      },
    },
    (target) =>
      withProxy(new Map([[3, target]]), async (proxy) => {
        const response = await send(proxy.port, '/editor/3/upload', {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body,
        });
        assert.equal(response.status, 200);
        assert.equal(response.body.toString(), 'stored');
      }),
  );
  assert.deepEqual(received, {
    length: body.length,
    hash: createHash('sha256').update(body).digest('hex'),
    type: 'application/octet-stream',
  });
});

test('HTTP: two sequential requests on one keep-alive client connection both succeed', async () => {
  const upstreamPeers: number[] = [];
  await withUpstream(
    {
      request: (request, response) => {
        upstreamPeers.push(request.socket.remotePort ?? -1);
        response.end(request.url);
      },
    },
    (target) =>
      withProxy(new Map([[1, target]]), async (proxy) => {
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        try {
          const first = await send(proxy.port, '/editor/1/a', { agent });
          const second = await send(proxy.port, '/editor/1/b', { agent });
          assert.equal(first.body.toString(), '/a');
          assert.equal(second.body.toString(), '/b');
          // A normal ending releases nothing: the client connection is reused...
          assert.equal(first.socket, second.socket);
        } finally {
          agent.destroy();
        }
      }),
  );
  // ...and so is the proxy's upstream connection.
  assert.equal(upstreamPeers.length, 2);
  assert.equal(upstreamPeers[0], upstreamPeers[1]);
});

test('HTTP: a client aborting mid-body closes the upstream request and ends the exchange', async () => {
  let upstreamRequest: http.IncomingMessage | undefined;
  const upstreamReceiving = Promise.withResolvers<void>();
  await withUpstream(
    {
      request: (request) => {
        upstreamRequest = request;
        request.once('data', () => upstreamReceiving.resolve());
      },
    },
    (target) =>
      withProxy(
        new Map([[1, target]]),
        async (proxy) => {
          const client = http.request({
            host: '127.0.0.1',
            port: proxy.port,
            path: '/editor/1/upload',
            method: 'POST',
            agent: false,
            headers: { 'content-type': 'text/plain', 'content-length': '1000' },
          });
          client.on('error', () => undefined);
          client.write('x'.repeat(100));
          await within(upstreamReceiving.promise);
          const upstreamClosed = closed(upstreamRequest!.socket);
          client.destroy();
          await upstreamClosed;
          await proxy.exchangeEnded();
        },
        { observed: true },
      ),
  );
});

test('HTTP: an unknown context gets 503 not_running, unlogged', async () => {
  await withProxy(new Map(), async (proxy) => {
    const response = await send(proxy.port, '/editor/9/x');
    assert.equal(response.status, 503);
    assert.match(String(response.headers['content-type']), /^application\/json/u);
    const error = unavailableBody(response.body);
    assert.equal(error.code, 'editor_proxy_unavailable');
    assert.equal(error.status, 503);
    assert.deepEqual(error.data, { reason: 'not_running', editorContextId: 9 });
    assert.equal(error.message, 'No running editor for context 9.');

    const unparsable = await send(proxy.port, '/editor/abc/x');
    assert.equal(unparsable.status, 503);
    assert.deepEqual(unavailableBody(unparsable.body).data, {
      reason: 'not_running',
      editorContextId: null,
    });
    assert.deepEqual(proxy.logs, []);
  });
});

test('HTTP: a closed upstream port gets 502 upstream_unreachable and a warning', async () => {
  const port = await closedPort();
  await withProxy(new Map([[4, { host: '127.0.0.1', port }]]), async (proxy) => {
    const response = await send(proxy.port, '/editor/4/');
    assert.equal(response.status, 502);
    const error = unavailableBody(response.body);
    assert.deepEqual(error.data, { reason: 'upstream_unreachable', editorContextId: 4 });
    assert.equal(error.message, 'The editor for context 4 did not answer.');
    assert.equal(proxy.logs.length, 1);
    const [entry] = proxy.logs;
    assert.equal(entry?.level, 'Warn');
    assert.deepEqual(entry?.message, ['Editor proxy could not reach Code Server']);
    assert.equal(entry?.annotations.editorContextId, 4);
    assert.equal(entry?.annotations.port, port);
    assert.equal(entry?.annotations.upgrade, false);
    assert.match(String(entry?.annotations.cause), /ECONNREFUSED/u);
  });
});

// ---------------------------------------------------------------------------
// Upgrades
// ---------------------------------------------------------------------------

test('upgrade: a binary WebSocket echo works both ways through the proxy', async () => {
  await withWebSocketUpstream((target) =>
    withProxy(new Map([[2, target]]), async (proxy) => {
      const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/editor/2/echo`);
      socket.binaryType = 'arraybuffer';
      const messages: Uint8Array[] = [];
      const received = (count: number) =>
        within(
          new Promise<void>((resolve) => {
            const check = () => (messages.length >= count ? resolve() : undefined);
            socket.addEventListener('message', (event) => {
              messages.push(new Uint8Array(event.data as ArrayBuffer));
              check();
            });
            check();
          }),
        );
      const firstMessage = received(1);
      await within(new Promise((resolve) => socket.addEventListener('open', resolve)));
      // Server to client, unprompted.
      await firstMessage;
      assert.deepEqual([...messages[0]!], [0xde, 0xad]);
      // Client to server and back.
      const payload = randomBytes(70_000);
      const echoed = received(2);
      socket.send(payload);
      await echoed;
      assert.deepEqual(Buffer.from(messages[1]!), payload);
      socket.close();
    }),
  );
});

test('upgrade: the request line and every header reach Code Server verbatim', async () => {
  let seen: { url?: string | undefined; headers?: http.IncomingHttpHeaders } = {};
  await withUpstream(
    {
      upgrade: (request, socket) => {
        seen = { url: request.url, headers: request.headers };
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Upstream: yes\r\n\r\nhello',
        );
        socket.on('data', (chunk) => socket.write(chunk));
      },
    },
    (target) =>
      withProxy(new Map([[5, target]]), async (proxy) => {
        const { outcome } = upgradeRequest(
          proxy.port,
          '/editor/5/stable/socket?reconnection=true',
          {
            host: 'vm.tail.ts.net',
            origin: 'https://vm.tail.ts.net',
            cookie: 'session=abc',
          },
        );
        const result = await outcome;
        assert.equal(result.kind, 'upgraded');
        if (result.kind !== 'upgraded') return;
        assert.equal(result.response.statusCode, 101);
        assert.equal(result.response.headers['x-upstream'], 'yes');
        // Bytes Code Server sent right after its 101 are not lost.
        let received = result.head.toString();
        result.socket.on('data', (chunk: Buffer) => (received += chunk.toString()));
        result.socket.write(' world');
        await within(
          new Promise<void>((resolve) => {
            const timer = setInterval(() => {
              if (received === 'hello world') {
                clearInterval(timer);
                resolve();
              }
            }, 5);
          }),
        );
        result.socket.destroy();
      }),
  );
  assert.equal(seen.url, '/stable/socket?reconnection=true');
  assert.equal(seen.headers?.host, 'vm.tail.ts.net');
  assert.equal(seen.headers?.origin, 'https://vm.tail.ts.net');
  assert.equal(seen.headers?.cookie, 'session=abc');
  assert.equal(seen.headers?.upgrade, 'websocket');
  assert.equal(seen.headers?.connection, 'Upgrade');
  assert.ok(seen.headers?.['sec-websocket-key']);
});

test('upgrade: a non-WebSocket upgrade is forwarded verbatim too', async () => {
  let seenUpgrade: string | undefined;
  await withUpstream(
    {
      upgrade: (request, socket) => {
        seenUpgrade = request.headers.upgrade;
        socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 2\r\nConnection: close\r\n\r\nno');
      },
    },
    (target) =>
      withProxy(new Map([[5, target]]), async (proxy) => {
        const { outcome } = upgradeRequest(proxy.port, '/editor/5/', { upgrade: 'h2c' });
        const result = await outcome;
        assert.equal(result.kind, 'response');
        if (result.kind !== 'response') return;
        assert.equal(result.response.statusCode, 400);
        assert.equal(result.body.toString(), 'no');
      }),
  );
  assert.equal(seenUpgrade, 'h2c');
});

test('upgrade: Code Server refusing the upgrade passes through and the client socket closes', async () => {
  await withUpstream(
    {
      upgrade: (_request, socket) => {
        socket.end(
          'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 6\r\n\r\ndenied',
        );
      },
    },
    (target) =>
      withProxy(new Map([[6, target]]), async (proxy) => {
        const { request, outcome } = upgradeRequest(proxy.port, '/editor/6/socket');
        const socketClosed = new Promise<void>((resolve) =>
          request.on('socket', (socket) => socket.once('close', () => resolve())),
        );
        const result = await outcome;
        assert.equal(result.kind, 'response');
        if (result.kind !== 'response') return;
        assert.equal(result.response.statusCode, 403);
        assert.equal(result.body.toString(), 'denied');
        await within(socketClosed);
      }),
  );
});

test('upgrade: resetting the client while Code Server withholds its 101 closes the upstream request', async () => {
  const upstreamReceived = Promise.withResolvers<Socket>();
  await withUpstream(
    { upgrade: (_request, socket) => upstreamReceived.resolve(socket) },
    (target) =>
      withProxy(
        new Map([[8, target]]),
        async (proxy) => {
          const { request, outcome } = upgradeRequest(proxy.port, '/editor/8/socket');
          outcome.catch(() => undefined);
          request.on('error', () => undefined);
          const upstreamSocket = await within(upstreamReceived.promise);
          // The stub's detached upgrade socket is half-open like the proxy's, so the proxy closing its side shows
          // up as `end` once the socket is read.
          const upstreamClosed = within(
            new Promise<void>((resolve) => {
              upstreamSocket.once('end', () => resolve());
              upstreamSocket.once('close', () => resolve());
              upstreamSocket.resume();
            }),
          );
          request.destroy();
          await upstreamClosed;
          await proxy.exchangeEnded();
        },
        { observed: true },
      ),
  );
});

test('upgrade: an unknown context gets 503 and the socket closes', async () => {
  await withProxy(new Map(), async (proxy) => {
    const { request, outcome } = upgradeRequest(proxy.port, '/editor/9/socket');
    const socketClosed = new Promise<void>((resolve) =>
      request.on('socket', (socket) => socket.once('close', () => resolve())),
    );
    const result = await outcome;
    assert.equal(result.kind, 'response');
    if (result.kind !== 'response') return;
    assert.equal(result.response.statusCode, 503);
    assert.deepEqual(unavailableBody(result.body).data, {
      reason: 'not_running',
      editorContextId: 9,
    });
    await within(socketClosed);
  });
});

test('upgrade: a closed upstream port gets 502 and a warning', async () => {
  const port = await closedPort();
  await withProxy(new Map([[4, { host: '127.0.0.1', port }]]), async (proxy) => {
    const { outcome } = upgradeRequest(proxy.port, '/editor/4/socket');
    const result = await outcome;
    assert.equal(result.kind, 'response');
    if (result.kind !== 'response') return;
    assert.equal(result.response.statusCode, 502);
    assert.deepEqual(unavailableBody(result.body).data, {
      reason: 'upstream_unreachable',
      editorContextId: 4,
    });
    assert.equal(proxy.logs.length, 1);
    assert.equal(proxy.logs[0]?.annotations.upgrade, true);
  });
});

test('upgrade: interrupting the routes destroys a live piped socket', async () => {
  const serverSocketClosed = Promise.withResolvers<void>();
  await withWebSocketUpstream(
    (target) =>
      withProxy(new Map([[2, target]]), async (proxy) => {
        const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/editor/2/echo`);
        await within(new Promise((resolve) => socket.addEventListener('open', resolve)));
        const clientClosed = within(
          new Promise<void>((resolve) => socket.addEventListener('close', () => resolve())),
        );
        await proxy.interruptRoutes();
        await clientClosed;
        await within(serverSocketClosed.promise);
      }),
    () => serverSocketClosed.resolve(),
  );
});
