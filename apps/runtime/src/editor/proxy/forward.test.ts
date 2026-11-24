import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import websocket from '@fastify/websocket';
import { Effect, Layer, Logger, References, Schema } from 'effect';
import Fastify, { type FastifyInstance } from 'fastify';

import { editorProxyUnavailableErrorSchema } from '@isagi/shared/contracts';

import type { RouteRuntime } from '../../platform/http/index.js';
import { withListeningServer, type ListeningServer } from '../../platform/http/testing.js';
import { EditorContextService } from '../contexts/service.js';
import { proxyExchange, upstreamRequestHeaders } from './forward.js';
import { registerEditorProxy } from './route.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Target {
  readonly socketPath: string;
}

type Targets = ReadonlyMap<number, Target>;

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
  options: { readonly observed?: boolean; readonly allowedOrigins?: readonly string[] } = {},
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
    { allowedOrigins: options.allowedOrigins ?? [] },
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

/**
 * A short, private directory for one test's UNIX sockets. Short because a socket path is capped near 104 bytes, and
 * under the system temp root for the same reason the runtime's own socket directory is.
 */
async function withSocketDirectory<A>(run: (directory: string) => Promise<A>): Promise<A> {
  const directory = mkdtempSync(join(tmpdir(), 'iep-'));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A stub Code Server: plain `node:http` on a UNIX socket, as Code Server listens, with an optional raw `upgrade` handler. */
function withUpstream<A>(
  handlers: {
    readonly request?: http.RequestListener;
    readonly upgrade?: (request: http.IncomingMessage, socket: Socket, head: Buffer) => void;
  },
  run: (target: Target) => Promise<A>,
): Promise<A> {
  return withSocketDirectory((directory) =>
    listenUpstream(join(directory, 'w.sock'), handlers, run),
  );
}

async function listenUpstream<A>(
  socketPath: string,
  handlers: {
    readonly request?: http.RequestListener;
    readonly upgrade?: (request: http.IncomingMessage, socket: Socket, head: Buffer) => void;
  },
  run: (target: Target) => Promise<A>,
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
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    return await run({ socketPath });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A stub Code Server that speaks WebSocket, for frame-level echo through the byte-level proxy. */
function withWebSocketUpstream<A>(
  run: (target: Target) => Promise<A>,
  onServerSocketClosed: () => void = () => undefined,
): Promise<A> {
  return withSocketDirectory((directory) =>
    listenWebSocketUpstream(join(directory, 'w.sock'), run, onServerSocketClosed),
  );
}

async function listenWebSocketUpstream<A>(
  socketPath: string,
  run: (target: Target) => Promise<A>,
  onServerSocketClosed: () => void,
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
  await upstream.listen({ path: socketPath });
  try {
    return await run({ socketPath });
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

/** A socket path nothing listens on: an incarnation that has gone away. */
function withAbsentUpstream<A>(run: (target: Target) => Promise<A>): Promise<A> {
  return withSocketDirectory((directory) => run({ socketPath: join(directory, 'gone.sock') }));
}

/** A raw upgrade's response head, read off the socket: for answers Fastify writes before any hijack. */
function upgradeStatus(result: UpgradeOutcome): number | undefined {
  return result.response.statusCode;
}

// ---------------------------------------------------------------------------
// Upstream request headers
// ---------------------------------------------------------------------------

test('upstream headers: Host is the upstream host, first, whatever the client named', () => {
  assert.deepEqual(upstreamRequestHeaders(['Host', 'vm.tail.ts.net', 'Accept', '*/*']), [
    'Host',
    'localhost',
    'Accept',
    '*/*',
  ]);
  // No client Host at all still presents one.
  assert.deepEqual(upstreamRequestHeaders([]), ['Host', 'localhost']);
});

test('upstream headers: an Origin becomes the upstream origin, and is never invented', () => {
  assert.deepEqual(
    upstreamRequestHeaders(['host', '127.0.0.1:11299', 'origin', 'http://127.0.0.1:5173']),
    ['Host', 'localhost', 'origin', 'http://localhost'],
  );
  assert.deepEqual(upstreamRequestHeaders(['host', '127.0.0.1:11299']), ['Host', 'localhost']);
});

test('upstream headers: Forwarded and every X-Forwarded-* header are dropped', () => {
  assert.deepEqual(
    upstreamRequestHeaders([
      'Host',
      'vm.tail.ts.net',
      'Forwarded',
      'host=evil.test;proto=https',
      'X-Forwarded-Host',
      'evil.test',
      'x-forwarded-proto',
      'https',
      'X-Forwarded-For',
      '10.0.0.1',
      'X-Forwardedness',
      'kept',
    ]),
    ['Host', 'localhost', 'X-Forwardedness', 'kept'],
  );
});

test('upstream headers: runtime credentials are dropped and everything else passes in order', () => {
  assert.deepEqual(
    upstreamRequestHeaders([
      'Host',
      'vm.tail.ts.net',
      'Authorization',
      'Bearer launcher-secret',
      'Cookie',
      'vscode-tkn=abc; isagi_session=v1.1.mac; other=def',
      'Upgrade',
      'websocket',
      'Sec-WebSocket-Key',
      'abc==',
      'Cookie',
      'isagi_session=v1.1.mac',
    ]),
    [
      'Host',
      'localhost',
      'Cookie',
      'vscode-tkn=abc; other=def',
      'Upgrade',
      'websocket',
      'Sec-WebSocket-Key',
      'abc==',
    ],
  );
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

test('HTTP: the prefix is stripped, the query kept, and Code Server sees a same-origin request', async () => {
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
  assert.equal(seen.headers?.host, 'localhost');
  assert.equal(seen.headers?.origin, 'http://localhost');
  assert.equal(seen.headers?.cookie, 'session=abc; other=def');
  assert.equal(seen.headers?.['x-forwarded-proto'], undefined);
});

test('HTTP: a foreign Origin is refused before Code Server is contacted; a same-host one passes', async () => {
  let contacted = 0;
  await withUpstream(
    {
      request: (_request, response) => {
        contacted += 1;
        response.end('ok');
      },
    },
    (target) =>
      withProxy(new Map([[7, target]]), async (proxy) => {
        const refused = await send(proxy.port, '/editor/7/x', {
          headers: { origin: 'http://evil.test' },
        });
        assert.equal(refused.status, 403);
        assert.equal(refused.body.toString(), 'Forbidden');
        assert.equal(contacted, 0);

        const sameHost = await send(proxy.port, '/editor/7/x', {
          headers: { origin: `http://127.0.0.1:${proxy.port}` },
        });
        assert.equal(sameHost.status, 200);
        assert.equal(contacted, 1);
      }),
  );
});

test('HTTP: an opaque Origin is refused before Code Server is contacted', async () => {
  let contacted = 0;
  await withUpstream(
    {
      request: (_request, response) => {
        contacted += 1;
        response.end('ok');
      },
    },
    (target) =>
      withProxy(new Map([[7, target]]), async (proxy) => {
        const refused = await send(proxy.port, '/editor/7/x', { headers: { origin: 'null' } });
        assert.equal(refused.status, 403);
        assert.equal(contacted, 0);
      }),
  );
});

test('HTTP: client-sent Forwarded and X-Forwarded-Host never reach Code Server', async () => {
  let seen: http.IncomingHttpHeaders | undefined;
  await withUpstream(
    {
      request: (request, response) => {
        seen = request.headers;
        response.end('ok');
      },
    },
    (target) =>
      withProxy(new Map([[7, target]]), async (proxy) => {
        const response = await send(proxy.port, '/editor/7/x', {
          headers: { 'x-forwarded-host': 'evil.test', forwarded: 'host=evil.test' },
        });
        assert.equal(response.status, 200);
      }),
  );
  assert.equal(seen?.host, 'localhost');
  assert.equal(seen?.['x-forwarded-host'], undefined);
  assert.equal(seen?.forwarded, undefined);
});

test('HTTP: the runtime login cookie and Authorization never reach Code Server; other cookies do', async () => {
  const seen: http.IncomingHttpHeaders[] = [];
  await withUpstream(
    {
      request: (request, response) => {
        seen.push(request.headers);
        response.end('ok');
      },
    },
    (target) =>
      withProxy(new Map([[7, target]]), async (proxy) => {
        const mixed = await send(proxy.port, '/editor/7/x', {
          headers: {
            authorization: 'Bearer launcher-secret',
            cookie: 'vscode-tkn=abc; isagi_session=v1.1.mac; other=def',
          },
        });
        assert.equal(mixed.status, 200);
        const onlyLogin = await send(proxy.port, '/editor/7/y', {
          headers: { cookie: 'isagi_session=v1.1.mac' },
        });
        assert.equal(onlyLogin.status, 200);
      }),
  );
  assert.equal(seen[0]?.authorization, undefined);
  assert.equal(seen[0]?.cookie, 'vscode-tkn=abc; other=def');
  assert.equal(seen[1]?.cookie, undefined);
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
  const upstreamPeers: Socket[] = [];
  await withUpstream(
    {
      request: (request, response) => {
        upstreamPeers.push(request.socket);
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

test('HTTP: an upstream socket nothing listens on gets 502 upstream_unreachable and a warning', async () => {
  await withAbsentUpstream((target) =>
    withProxy(new Map([[4, target]]), async (proxy) => {
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
      assert.equal(entry?.annotations.socketPath, target.socketPath);
      assert.equal(entry?.annotations.upgrade, false);
      assert.match(String(entry?.annotations.cause), /ENOENT|ECONNREFUSED/u);
    }),
  );
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

test('upgrade: the request line reaches Code Server verbatim, with the headers presented as same-origin', async () => {
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
  assert.equal(seen.headers?.host, 'localhost');
  assert.equal(seen.headers?.origin, 'http://localhost');
  assert.equal(seen.headers?.cookie, 'session=abc');
  assert.equal(seen.headers?.upgrade, 'websocket');
  assert.equal(seen.headers?.connection, 'Upgrade');
  assert.ok(seen.headers?.['sec-websocket-key']);
});

test('upgrade: the runtime login cookie and Authorization never reach Code Server; other cookies do', async () => {
  let seen: http.IncomingHttpHeaders | undefined;
  await withUpstream(
    {
      upgrade: (request, socket) => {
        seen = request.headers;
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
        );
      },
    },
    (target) =>
      withProxy(new Map([[5, target]]), async (proxy) => {
        const { outcome } = upgradeRequest(proxy.port, '/editor/5/socket', {
          host: 'vm.tail.ts.net',
          authorization: 'Bearer launcher-secret',
          cookie: 'isagi_session=v1.1.mac; vscode-tkn=abc',
        });
        const result = await outcome;
        assert.equal(result.kind, 'upgraded');
        if (result.kind === 'upgraded') result.socket.destroy();
      }),
  );
  assert.equal(seen?.authorization, undefined);
  assert.equal(seen?.cookie, 'vscode-tkn=abc');
  assert.equal(seen?.upgrade, 'websocket');
});

test('upgrade: a non-WebSocket upgrade is forwarded too', async () => {
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

test('upgrade: an upstream socket nothing listens on gets 502 and a warning', async () => {
  await withAbsentUpstream((target) =>
    withProxy(new Map([[4, target]]), async (proxy) => {
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
      assert.equal(proxy.logs[0]?.annotations.socketPath, target.socketPath);
    }),
  );
});

/** A stub upgrade handler that records what Code Server saw and accepts. */
function acceptingUpgrade(seen: http.IncomingHttpHeaders[]) {
  return (request: http.IncomingMessage, socket: Socket) => {
    seen.push(request.headers);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
  };
}

test('upgrade: an allowed Origin on a different host is admitted and presented as same-origin', async () => {
  const seen: http.IncomingHttpHeaders[] = [];
  await withUpstream({ upgrade: acceptingUpgrade(seen) }, (target) =>
    withProxy(
      new Map([[5, target]]),
      async (proxy) => {
        // Host is the server's own address; Origin is the dev UI's. Code Server's Origin-against-Host check would
        // refuse this pair, so admission must be the runtime's alone.
        const { outcome } = upgradeRequest(proxy.port, '/editor/5/socket', {
          origin: 'http://127.0.0.1:5173',
        });
        const result = await outcome;
        assert.equal(upgradeStatus(result), 101);
        if (result.kind === 'upgraded') result.socket.destroy();
      },
      { allowedOrigins: ['http://127.0.0.1:5173'] },
    ),
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.host, 'localhost');
  assert.equal(seen[0]?.origin, 'http://localhost');
});

test('upgrade: a foreign Origin is refused with 403 and Code Server is never contacted', async () => {
  const seen: http.IncomingHttpHeaders[] = [];
  await withUpstream({ upgrade: acceptingUpgrade(seen) }, (target) =>
    withProxy(
      new Map([[5, target]]),
      async (proxy) => {
        const { request, outcome } = upgradeRequest(proxy.port, '/editor/5/socket', {
          origin: 'http://evil.test',
        });
        const socketClosed = new Promise<void>((resolve) =>
          request.on('socket', (socket) => socket.once('close', () => resolve())),
        );
        const result = await outcome;
        assert.equal(result.kind, 'response');
        assert.equal(upgradeStatus(result), 403);
        await within(socketClosed);
      },
      { allowedOrigins: ['http://127.0.0.1:5173'] },
    ),
  );
  assert.equal(seen.length, 0);
});

test('upgrade: an opaque Origin is refused with 403 and Code Server is never contacted', async () => {
  const seen: http.IncomingHttpHeaders[] = [];
  await withUpstream({ upgrade: acceptingUpgrade(seen) }, (target) =>
    withProxy(new Map([[5, target]]), async (proxy) => {
      const { request, outcome } = upgradeRequest(proxy.port, '/editor/5/socket', {
        origin: 'null',
      });
      const socketClosed = new Promise<void>((resolve) =>
        request.on('socket', (socket) => socket.once('close', () => resolve())),
      );
      const result = await outcome;
      assert.equal(result.kind, 'response');
      assert.equal(upgradeStatus(result), 403);
      await within(socketClosed);
    }),
  );
  assert.equal(seen.length, 0);
});

test('upgrade: client-sent Forwarded and X-Forwarded-* never reach Code Server', async () => {
  const seen: http.IncomingHttpHeaders[] = [];
  await withUpstream({ upgrade: acceptingUpgrade(seen) }, (target) =>
    withProxy(new Map([[5, target]]), async (proxy) => {
      const { outcome } = upgradeRequest(proxy.port, '/editor/5/socket', {
        'x-forwarded-host': 'evil.test',
        'x-forwarded-proto': 'https',
        forwarded: 'host=evil.test;proto=https',
      });
      const result = await outcome;
      assert.equal(upgradeStatus(result), 101);
      if (result.kind === 'upgraded') result.socket.destroy();
    }),
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.host, 'localhost');
  assert.equal(seen[0]?.['x-forwarded-host'], undefined);
  assert.equal(seen[0]?.['x-forwarded-proto'], undefined);
  assert.equal(seen[0]?.forwarded, undefined);
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
