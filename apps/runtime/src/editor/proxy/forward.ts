import http from 'node:http';
import type { Socket } from 'node:net';

import { Effect } from 'effect';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { EditorProxyUnavailableError } from '@isagi/contracts';

import { errorMessage } from '../../platform/http/index.js';
import { EditorContextService } from '../contexts/service.js';
import { editorProxyRequestTarget } from './target.js';

/**
 * One proxied exchange, run after the route hook hijacked the reply: resolve the context's live incarnation, then
 * forward the request to it byte for byte, as plain HTTP or as an upgrade.
 *
 * Hijacking removed Fastify's own abort and timeout handling, so each forward owns client-disconnect handling from its
 * first moment (the lifecycle rule on `forwardHttp` and `forwardUpgrade`). There is no timeout and no retry; shutdown
 * interrupts the fiber, which ends the forward the same way a disconnect does.
 */
export const proxyExchange = (input: {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly agent: http.Agent;
}): Effect.Effect<void, never, EditorContextService> => {
  const { request, reply, agent } = input;
  const target = editorProxyRequestTarget(request.raw.url ?? '');
  const editorContextId = target?.editorContextId ?? null;
  return Effect.gen(function* () {
    // Every upgrade, whatever protocol it names, reaches Fastify through `@fastify/websocket`'s `upgrade` listener,
    // which marks it here. A header test would send a non-WebSocket upgrade down the HTTP path, whose body the parser
    // never reads; forwarding every upgrade verbatim lets Code Server answer or refuse it.
    const upgrade = request.ws === true;
    const location =
      target === null
        ? null
        : yield* EditorContextService.use((editors) => editors.proxyTarget(target.editorContextId));
    if (target === null || location === null) {
      // Not logged: a stale tab after a restart, or an editor that just stopped, is ordinary.
      answerUnavailable({ request, reply, upgrade, editorContextId, reason: 'not_running' });
      return;
    }

    const forward = { request, reply, path: target.path, ...location };
    const ending = yield* upgrade ? forwardUpgrade(forward) : forwardHttp({ ...forward, agent });
    if (ending._tag === 'unreachable') {
      yield* Effect.logWarning('Editor proxy could not reach Code Server').pipe(
        Effect.annotateLogs({
          port: location.port,
          upgrade,
          cause: errorMessage(ending.cause),
        }),
      );
      answerUnavailable({
        request,
        reply,
        upgrade,
        editorContextId,
        reason: 'upstream_unreachable',
      });
    }
  }).pipe(Effect.annotateLogs({ editorContextId }));
};

/**
 * How a forward ended. `unreachable` means the upstream connection failed before anything was written to the client,
 * so the client is still owed an answer; every other ending (a normal finish, a disconnect on either side,
 * interruption) has already released what it had to.
 */
type ForwardEnding =
  | { readonly _tag: 'finished' }
  | { readonly _tag: 'unreachable'; readonly cause: unknown };

const finished: ForwardEnding = { _tag: 'finished' };

interface Forward {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  /** The upstream path and query, as cut from the raw URL. */
  readonly path: string;
  readonly host: string;
  readonly port: number;
}

/**
 * Connection-level headers that describe one leg, not the message. Node frames each leg itself. Everything else,
 * including `Host`, `Origin`, `Cookie` and `X-Forwarded-*`, passes unchanged, because Code Server checks Origin
 * against Host. #65's login-cookie stripping belongs in this copy.
 */
const hopByHopHeaders = new Set(['connection', 'keep-alive', 'transfer-encoding']);

function endToEndHeaders(rawHeaders: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!;
    if (!hopByHopHeaders.has(name.toLowerCase())) kept.push(name, rawHeaders[index + 1]!);
  }
  return kept;
}

/**
 * A plain HTTP forward over the shared keep-alive agent.
 *
 * Lifecycle rule: the client-side listener (`reply.raw` `close`) is attached before the upstream request exists, and
 * every event that can end the forward calls the one idempotent `end`, as does interruption through the callback's
 * finalizer. A `close` after `reply.raw` finished normally releases nothing, so the client's keep-alive connection and
 * the agent's upstream socket stay usable. Any other ending destroys the upstream request and, unless the client is
 * still owed an answer, `reply.raw`.
 */
function forwardHttp(
  input: Forward & { readonly agent: http.Agent },
): Effect.Effect<ForwardEnding> {
  return Effect.callback<ForwardEnding>((resume) => {
    const { request, reply } = input;
    const response = reply.raw;
    let ended = false;
    let upstream: http.ClientRequest | undefined;

    const end = (ending: ForwardEnding | 'aborted') => {
      if (ended) return;
      ended = true;
      response.removeListener('close', onClientClose);
      if (ending !== finished) {
        upstream?.destroy();
        if (ending === 'aborted') response.destroy();
      }
      resume(Effect.succeed(ending === 'aborted' ? finished : ending));
    };
    const onClientClose = () => end(response.writableFinished ? finished : 'aborted');
    response.on('close', onClientClose);

    try {
      upstream = http.request({
        host: input.host,
        port: input.port,
        method: request.raw.method,
        path: input.path,
        headers: endToEndHeaders(request.raw.rawHeaders),
        agent: input.agent,
      });
    } catch (cause) {
      end({ _tag: 'unreachable', cause });
      return;
    }
    upstream.on('error', (cause) =>
      end(response.headersSent ? 'aborted' : { _tag: 'unreachable', cause }),
    );
    upstream.on('response', (upstreamResponse) => {
      // An upstream that dies mid-body leaves the client with a truncated response it cannot tell from a whole one,
      // so the forward ends as aborted and the client connection goes with it.
      upstreamResponse.on('close', () => {
        if (!upstreamResponse.complete) end('aborted');
      });
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        endToEndHeaders(upstreamResponse.rawHeaders),
      );
      upstreamResponse.pipe(response);
    });
    request.raw.pipe(upstream);

    return Effect.sync(() => end('aborted'));
  });
}

/**
 * An upgrade forwarded byte for byte: the request line and headers verbatim on a fresh connection (`agent: false`),
 * then, after Code Server's `101`, the two sockets piped together.
 *
 * Lifecycle rule: the client socket's `close` and `error` listeners are attached before the upstream request exists,
 * and cover the pending, refused and established phases alike. Until a `101`, the client's `end` counts too: the HTTP
 * server allows half-open sockets, and nothing else ends a detached upgrade socket whose peer went away. After a
 * `101`, the pipe carries a half-close to Code Server like any other byte, and its close ends the exchange. Every
 * ending destroys everything still open, because neither socket is reusable once the exchange is over, except
 * `unreachable`, which leaves the client socket for the caller's answer.
 *
 * The listeners stay attached after the ending (`end` ignores repeats): the HTTP server stops handling `error` on a
 * socket it handed to an `upgrade` listener, so a late reset with no listener would crash the process.
 *
 * `@fastify/websocket` also stashes the client's `head` buffer (bytes read past the request headers) under a private
 * symbol. It is ignored: an RFC 6455 client waits for the `101` before sending, so the buffer is empty.
 */
function forwardUpgrade(input: Forward): Effect.Effect<ForwardEnding> {
  return Effect.callback<ForwardEnding>((resume) => {
    const { request, reply } = input;
    const client: Socket = request.raw.socket;
    let ended = false;
    let written = false;
    let upstream: http.ClientRequest | undefined;
    let upstreamSocket: Socket | undefined;

    const end = (ending: ForwardEnding) => {
      if (ended) return;
      ended = true;
      upstream?.destroy();
      upstreamSocket?.destroy();
      if (ending._tag !== 'unreachable') client.destroy();
      resume(Effect.succeed(ending));
    };
    const onClientGone = () => end(finished);
    client.on('close', onClientGone);
    client.on('error', onClientGone);
    client.on('end', onClientGone);

    try {
      upstream = http.request({
        host: input.host,
        port: input.port,
        method: request.raw.method,
        path: input.path,
        headers: [...request.raw.rawHeaders],
        agent: false,
      });
    } catch (cause) {
      end({ _tag: 'unreachable', cause });
      return;
    }
    upstream.on('error', (cause) => end(written ? finished : { _tag: 'unreachable', cause }));
    upstream.on('upgrade', (upstreamResponse, socket, upstreamHead) => {
      upstreamSocket = socket;
      if (ended) {
        socket.destroy();
        return;
      }
      written = true;
      client.removeListener('end', onClientGone);
      let head = `HTTP/1.1 101 Switching Protocols\r\n`;
      const raw = upstreamResponse.rawHeaders;
      for (let index = 0; index + 1 < raw.length; index += 2)
        head += `${raw[index]}: ${raw[index + 1]}\r\n`;
      client.write(`${head}\r\n`);
      if (upstreamHead.length > 0) client.write(upstreamHead);
      for (const side of [client, socket]) {
        side.setNoDelay(true);
        side.setTimeout(0);
      }
      socket.on('close', () => end(finished));
      socket.on('error', () => end(finished));
      socket.pipe(client);
      client.pipe(socket);
    });
    upstream.on('response', (upstreamResponse) => {
      // Code Server declined the upgrade (for example its own Origin check): its answer passes through, and the
      // client socket closes once it is sent.
      written = true;
      upstreamResponse.on('close', () => {
        if (!upstreamResponse.complete) end(finished);
      });
      reply.raw.on('finish', () => end(finished));
      reply.raw.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        upstreamResponse.rawHeaders,
      );
      upstreamResponse.pipe(reply.raw);
    });
    upstream.end();

    return Effect.sync(() => end(finished));
  });
}

const unavailableMessages = {
  not_running: (id: number | null) =>
    id === null ? 'No running editor for this address.' : `No running editor for context ${id}.`,
  upstream_unreachable: (id: number | null) => `The editor for context ${id} did not answer.`,
} as const;

/**
 * The proxy's own answer, written to `reply.raw` because the reply is hijacked. For an upgrade, `reply.raw` is
 * `@fastify/websocket`'s response bound to the client socket; the proxy closes that socket once the answer is sent,
 * since the plugin's `onResponse` cleanup never runs for a hijacked reply.
 */
function answerUnavailable(input: {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly upgrade: boolean;
  readonly editorContextId: number | null;
  readonly reason: EditorProxyUnavailableError['data']['reason'];
}): void {
  const { request, reply, editorContextId, reason } = input;
  const response = reply.raw;
  const error: EditorProxyUnavailableError = {
    code: 'editor_proxy_unavailable',
    status: reason === 'not_running' ? 503 : 502,
    message: unavailableMessages[reason](editorContextId),
    requestId: String(request.id),
    data: { reason, editorContextId },
  };
  const socket = request.raw.socket;
  if (response.destroyed || response.headersSent) {
    if (input.upgrade) socket.destroy();
    return;
  }
  response.writeHead(error.status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error }), () => {
    if (input.upgrade) socket.destroy();
  });
}
