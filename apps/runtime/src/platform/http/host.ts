import { isIP, isIPv4, isIPv6 } from 'node:net';

import type { FastifyInstance } from 'fastify';

import { sendApiError } from './errors.js';

const bracketedHost = /^\[([^\]]+)\](?::\d+)?$/;
const namedHost = /^([a-z0-9._-]+)(?::\d+)?$/;

/**
 * The hostname a Host header names, lowercased, brackets removed; null when missing or malformed.
 *
 * Deliberately not `new URL('http://' + value)`: that accepts userinfo, so `a@127.0.0.1` would parse as loopback.
 */
export function hostnameFromHostHeader(value: string | undefined): string | null {
  if (value === undefined) return null;
  const lowered = value.toLowerCase();
  if (lowered.startsWith('[')) {
    const address = bracketedHost.exec(lowered)?.[1];
    return address !== undefined && isIPv6(address) ? address : null;
  }
  return namedHost.exec(lowered)?.[1] ?? null;
}

/** `localhost`, `*.localhost`, 127.0.0.0/8 or `::1`. Also classifies listen addresses (`exposureWarnings`). */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    (isIPv4(hostname) && hostname.startsWith('127.')) ||
    hostname === '::1'
  );
}

/** Exact entries, `*.` suffixes (kept with their leading dot) and the bare `*`, built once at install. */
interface HostPolicy {
  readonly exact: ReadonlySet<string>;
  readonly suffixes: readonly string[];
  readonly any: boolean;
}

function hostPolicy(allowedHosts: readonly string[]): HostPolicy {
  return {
    exact: new Set(allowedHosts.filter((entry) => !entry.startsWith('*'))),
    suffixes: allowedHosts.filter((entry) => entry.startsWith('*.')).map((entry) => entry.slice(1)),
    any: allowedHosts.includes('*'),
  };
}

function admits(policy: HostPolicy, hostname: string) {
  return (
    isLoopbackHostname(hostname) ||
    policy.any ||
    policy.exact.has(hostname) ||
    (isIP(hostname) === 0 && policy.suffixes.some((suffix) => hostname.endsWith(suffix)))
  );
}

/**
 * Installs the global `onRequest` guard: a request is admitted only when its Host is loopback or matched by
 * `allowedHosts` (#64 AC4, against DNS rebinding). There is no other rule, not even for the runtime's own
 * non-loopback listen address. `allowedHosts` must already be lowercased (`runtime-config/policy.ts` does).
 *
 * Register it after `@fastify/websocket`, so a refused upgrade's socket is destroyed by that plugin's `onResponse`
 * hook, and before `@fastify/cors`, whose hook would otherwise answer a refused host's preflight.
 */
export function installHostGuard(fastify: FastifyInstance, allowedHosts: readonly string[]) {
  const policy = hostPolicy(allowedHosts);
  fastify.addHook('onRequest', (request, reply, done) => {
    const raw = request.headers.host;
    const hostname = hostnameFromHostHeader(raw);
    if (hostname !== null && admits(policy, hostname)) {
      done();
      return;
    }
    // Answered without `done`: Fastify skips the remaining hooks and the route once the reply is sent.
    void sendApiError(reply, {
      code: 'api_host_not_allowed',
      status: 403,
      message: `Requests for host "${hostname ?? raw ?? '(none)'}" are not allowed. Add it to server.allowedHosts in the runtime's config.yaml, then restart the runtime.`,
      requestId: String(request.id),
      data: { host: raw ?? null },
    });
  });
}
