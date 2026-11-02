import type { FastifyContextConfig, FastifyInstance } from 'fastify';

import { sendApiError } from '../platform/http/index.js';
import type { Access } from './service.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Admitted without credentials by the access guard. Set only through `publicRoute`. */
    readonly isagiPublic?: true;
  }
}

/** The route-config marker for a route anyone may call with login on: health, login and the web UI files. */
export const publicRoute = { isagiPublic: true } as const satisfies FastifyContextConfig;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/**
 * Installs the global `onRequest` access guard; call it only when login is on. A request passes when the route Fastify
 * matched is public or no route matched (the not-found handler answers, exposing nothing), or when it carries a valid
 * bearer token or login cookie. Otherwise it is answered `401 auth_required`.
 *
 * Public means the matched route, never `request.url`: the router decodes percent-encoding before matching, so
 * `/%61pi/v1/...` reaches an API route that a raw-path test would call a web UI path.
 *
 * Register it right after `@fastify/cors`: preflights, which carry no credentials, are answered there first, and a
 * 401 then carries the CORS headers a cross-origin client needs to read it. No loopback, Host or Origin exemption.
 */
export function installAccessGuard(fastify: FastifyInstance, access: Access['Service']): void {
  fastify.addHook('onRequest', (request, reply, done) => {
    if (request.is404 || request.routeOptions.config.isagiPublic === true) {
      done();
      return;
    }
    const admission = access.admit(
      {
        authorization: first(request.headers.authorization),
        cookie: first(request.headers.cookie),
      },
      Math.floor(Date.now() / 1000),
    );
    if (admission._tag === 'admitted') {
      // `request.ws` is @fastify/websocket's upgrade marker, set by its earlier hook; a 101 never carries the renewal.
      if (admission.renewCookie !== undefined && !request.ws) {
        reply.header('set-cookie', admission.renewCookie);
      }
      done();
      return;
    }
    // Answered without `done`, like the Host guard. Not logged: a signed-out browser is routine.
    void sendApiError(reply, {
      code: 'auth_required',
      status: 401,
      message:
        'Sign in to this runtime, or call it from an Isagi terminal or agent, which sets ISAGI_RUNTIME_TOKEN.',
      requestId: String(request.id),
      data: {},
    });
  });
}
