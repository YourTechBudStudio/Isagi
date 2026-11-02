import { Effect } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints } from '@isagi/contracts';

import { registerApiEndpoint, type RouteRuntime } from '../platform/http/index.js';
import { clearedSessionSetCookie } from './cookie.js';
import { publicRoute } from './guard.js';
import type { Access } from './service.js';

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * The auth endpoints. `auth.session` always answers (`none` with login off); `auth.login` (public) and `auth.logout`
 * exist only with login on, so with it off they are `api_route_not_found`.
 */
export function registerAccessRoutes(
  fastify: FastifyInstance,
  runtime: RouteRuntime<never>,
  access: Access['Service'],
): void {
  registerApiEndpoint(fastify, runtime, apiEndpoints.auth.session, (request) =>
    Effect.sync(() => ({
      credential: access.credentialOf(
        {
          authorization: request.http.header('authorization'),
          cookie: request.http.header('cookie'),
        },
        nowSeconds(),
      ),
    })),
  );
  if (access.mode !== 'enabled') return;
  registerApiEndpoint(
    fastify,
    runtime,
    apiEndpoints.auth.login,
    (request) =>
      access.login(request.body).pipe(
        Effect.map((cookie) => {
          // Replaces a renewal the guard may have added, so the reply carries exactly one login cookie.
          request.http.setReplyHeader('set-cookie', cookie);
          return null;
        }),
        Effect.catchTag('AccessLoginFailed', () =>
          request.reject({
            code: 'auth_login_failed',
            status: 401,
            message: 'Wrong username or password.',
          }),
        ),
      ),
    { config: publicRoute },
  );
  registerApiEndpoint(fastify, runtime, apiEndpoints.auth.logout, (request) =>
    Effect.sync(() => {
      request.http.setReplyHeader('set-cookie', clearedSessionSetCookie);
      return null;
    }),
  );
}
