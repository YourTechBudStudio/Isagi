import type { AddressInfo } from 'node:net';

import { Data } from 'effect';

import type { SourcedValue } from '@isagi/cli/serve-launch';

import type { RuntimeConfigShape } from '../runtime-config/index.js';
import type { ServerLaunch } from './launch.js';

/** Where the server listens, and where each value came from. */
export interface ListenSettings {
  readonly host: SourcedValue<string>;
  readonly port: SourcedValue<number>;
}

const defaultHost: SourcedValue<string> = {
  value: '127.0.0.1',
  source: 'default',
  name: 'default',
};
// Port 0 asks the OS for any free port.
const defaultPort: SourcedValue<number> = { value: 0, source: 'default', name: 'default' };

/**
 * The listen settings by precedence: what `serve` resolved (flag, then environment), then
 * `config.yaml` `server.*`, then the default. `serve` validated its tiers and the config parser
 * validated the file, so nothing here can fail.
 */
export function resolveListenSettings(
  launch: Pick<ServerLaunch['Service'], 'host' | 'port'>,
  config: RuntimeConfigShape['server'],
): ListenSettings {
  return {
    host:
      launch.host ??
      (config.host === undefined
        ? defaultHost
        : { value: config.host, source: 'config', name: 'server.host' }),
    port:
      launch.port ??
      (config.port === undefined
        ? defaultPort
        : { value: config.port, source: 'config', name: 'server.port' }),
  };
}

/**
 * A URL a local client can dial. Fastify's own listen URL is not used because its choice for a
 * wildcard bind is unreliable; a wildcard bind is reachable on loopback, so that is what is reported.
 * Every PTY's `ISAGI_RUNTIME_URL` and the desktop's readiness check read this.
 */
export function localRuntimeUrl(address: AddressInfo): string {
  if (address.address === '0.0.0.0' || address.address === '::') {
    return `http://127.0.0.1:${address.port}`;
  }
  if (address.family === 'IPv6' || address.address.includes(':')) {
    return `http://[${address.address}]:${address.port}`;
  }
  return `http://${address.address}:${address.port}`;
}

/** `--port`, `ISAGI_PORT`, `config.yaml server.port` or `default`: where a value came from, as the user wrote it. */
export function describeSource(value: SourcedValue<unknown>): string {
  return value.source === 'config' ? `config.yaml ${value.name}` : value.name;
}

/** The server could not bind. The message is the startup failure line, so it names both values and their sources. */
export class RuntimeListenFailed extends Data.TaggedError('RuntimeListenFailed')<{
  readonly host: SourcedValue<string>;
  readonly port: SourcedValue<number>;
  readonly cause: Error;
}> {
  override get message() {
    return (
      `Could not listen on ${formatHostPort(this.host.value, this.port.value)} ` +
      `(host from ${describeSource(this.host)}, port from ${describeSource(this.port)}): ${this.cause.message}`
    );
  }
}

function formatHostPort(host: string, port: number) {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}
