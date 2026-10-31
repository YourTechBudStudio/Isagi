import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    /** The browser origins this server accepts, installed by `installAllowedOrigins`. */
    readonly isagiAllowedOrigins?: ReadonlySet<string>;
  }
}

const noOrigins: ReadonlySet<string> = new Set();

export function isAllowedRuntimeOrigin(origin: string | undefined, allowed: ReadonlySet<string>) {
  // Local non-browser clients commonly omit Origin, and opaque origins use null.
  // This is a deliberate local-client trust allowance, not browser authentication.
  // The packaged desktop's concrete file:// origin is configured explicitly.
  if (!origin || origin === 'null') {
    return true;
  }

  return allowed.has(origin);
}

/**
 * Installs the instance's allowed-origin set (from `serve --allowed-origins`). Call it before
 * registering routes, so every plugin context inherits it.
 */
export function installAllowedOrigins(fastify: FastifyInstance, origins: Iterable<string>) {
  fastify.decorate('isagiAllowedOrigins', new Set(origins));
}

/** The WebSocket `preValidation` guard: checks against the set of the instance serving the request. */
export function enforceRuntimeWebSocketOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
) {
  const header = request.headers.origin;
  const origin = Array.isArray(header) ? header[0] : header;
  if (!isAllowedRuntimeOrigin(origin, request.server.isagiAllowedOrigins ?? noOrigins)) {
    reply.code(403).send('Forbidden');
    return;
  }
  done();
}
