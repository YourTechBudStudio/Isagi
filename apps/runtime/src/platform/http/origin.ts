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

/**
 * The Origin names the same host (hostname and port) as the request's Host header. The scheme is ignored: behind
 * `tailscale serve` the page's Origin is `https:` while the runtime sees plain HTTP, and the Host guard has already
 * vetted the host. A Host that spells a default port (`vm.ts.net:443`) does not match the Origin's normalised host;
 * browsers do not send that form.
 */
export function isSameHostOrigin(origin: string, hostHeader: string | undefined) {
  if (hostHeader === undefined) return false;
  try {
    return new URL(origin).host === hostHeader.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * The runtime's browser-origin admission rule, the one every WebSocket it terminates or proxies is held to: the origins
 * of the instance serving the request (see `isAllowedRuntimeOrigin`), and a page served from the runtime's own address
 * (same host). Proxied backends never decide this themselves; the editor proxy applies it before Code Server sees the
 * request.
 */
export function isAdmittedRuntimeOrigin(request: FastifyRequest): boolean {
  const header = request.headers.origin;
  const origin = Array.isArray(header) ? header[0] : header;
  return (
    isAllowedRuntimeOrigin(origin, request.server.isagiAllowedOrigins ?? noOrigins) ||
    (origin !== undefined && isSameHostOrigin(origin, request.headers.host))
  );
}

/** The WebSocket `preValidation` guard: refuses an origin `isAdmittedRuntimeOrigin` does not admit. */
export function enforceRuntimeWebSocketOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
) {
  if (!isAdmittedRuntimeOrigin(request)) {
    reply.code(403).send('Forbidden');
    return;
  }
  done();
}
