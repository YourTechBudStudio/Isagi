import http from 'node:http';

import type { FastifyInstance } from 'fastify';

import type { RouteRuntime } from '../../platform/http/index.js';
import type { EditorContextService } from '../contexts/service.js';
import { proxyExchange } from './forward.js';

/**
 * The editor proxy: Code Server is only ever reached through the runtime, at `/editor/<editorContextId>/…` (#64 AC3).
 * Always registered, and admitted by the server's global Host guard like every other request; it applies no Origin
 * rule of its own, because Code Server checks Origin against Host.
 *
 * Registered after `@fastify/websocket`, so upgrades to these paths are routed here too.
 */
export function registerEditorProxy(
  fastify: FastifyInstance,
  runtime: RouteRuntime<EditorContextService>,
): void {
  // One keep-alive pool for plain HTTP exchanges, so the workbench's many asset requests reuse upstream connections.
  // Upgrades never use it.
  const agent = new http.Agent({ keepAlive: true });
  fastify.addHook('onClose', (_instance, done) => {
    agent.destroy();
    done();
  });

  fastify.all(
    '/editor/:editorContextId/*',
    {
      onRequest: (request, reply, done) => {
        // Route-level, so the global hooks (the Host guard; #65's login) already ran. Before body parsing, so the raw
        // stream reaches Code Server untouched. Hijacking skips the rest of the chain, including
        // `@fastify/websocket`'s handler wrapper, which would otherwise complete a ws handshake itself. Forked on the
        // server's request fibers, so shutdown interrupts the exchange and closes its sockets.
        reply.hijack();
        runtime.runFork(proxyExchange({ request, reply, agent }));
        // Fastify stops here: the reply is already sent as far as it knows.
        done();
      },
    },
    () => {
      // Unreachable: the route's `onRequest` hook hijacks every request before the handler could run.
      throw new Error('The editor proxy handler ran without its onRequest hook.');
    },
  );
}
