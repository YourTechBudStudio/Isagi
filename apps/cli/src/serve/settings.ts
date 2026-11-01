import { join, resolve } from 'node:path';

import { Option } from 'effect';

import { CliFailure } from '../errors.js';
import { fromFlagOrEnv } from '../settings.js';
import type { RuntimeLaunch, SourcedValue } from './launch.js';

/** `serve`'s flags as the command parses them: every value is a string, validated here. */
export interface ServeFlags {
  readonly host: Option.Option<string>;
  readonly port: Option.Option<string>;
  readonly dataDir: Option.Option<string>;
  readonly webRoot: Option.Option<string>;
  readonly allowedOrigins: Option.Option<string>;
}

export type ServeSettings = Omit<RuntimeLaunch, 'cliEntryPath'>;

/**
 * The flag and environment tiers of every `serve` setting, validated and tagged with their source.
 * `config.yaml` and the defaults for host and port are the runtime's to resolve, so those stay
 * `undefined` here. The web root is `--web-root`, else the build bundled with this `isagi`, else
 * none. The first invalid setting fails, and an invalid value never falls through to a
 * lower tier. Pure: `home` and `cwd` come from the caller.
 */
export function resolveServeLaunch(
  flags: ServeFlags,
  process: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly cwd: string;
    readonly home: string;
  },
  bundled: { readonly webRoot: string | undefined },
):
  | { readonly ok: true; readonly settings: ServeSettings }
  | { readonly ok: false; readonly failure: CliFailure } {
  const read = (flag: Option.Option<string>, flagName: `--${string}`, envName?: string) =>
    fromFlagOrEnv({
      flag: Option.getOrUndefined(flag),
      flagName,
      envName,
      env: process.env,
    });

  const host = read(flags.host, '--host', 'ISAGI_HOST');
  if (host !== undefined && host.value === '') {
    return refused('host', host, 'a listen address such as 127.0.0.1 or 0.0.0.0', '--host');
  }

  const portText = read(flags.port, '--port', 'ISAGI_PORT');
  let port: SourcedValue<number> | undefined;
  if (portText !== undefined) {
    const value = /^\d+$/.test(portText.value) ? Number(portText.value) : Number.NaN;
    if (!(value <= 65535)) {
      return refused('port', portText, 'a whole number from 0 to 65535', '--port');
    }
    port = { ...portText, value };
  }

  const dataDirectory = read(flags.dataDir, '--data-dir', 'ISAGI_DATA_DIR') ?? {
    value: '~/.isagi',
    source: 'default',
    name: 'default',
  };
  if (dataDirectory.value === '') {
    return refused('dataDirectory', dataDirectory, 'a directory path', '--data-dir');
  }

  const webRootFlag = read(flags.webRoot, '--web-root');
  if (webRootFlag !== undefined && webRootFlag.value === '') {
    return refused('webRoot', webRootFlag, 'a directory path', '--web-root');
  }

  const origins = read(flags.allowedOrigins, '--allowed-origins');
  const allowedOrigins = (origins?.value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (origins !== undefined && !allowedOrigins.every(isAllowedOrigin)) {
    return refused(
      'allowedOrigins',
      origins,
      'a comma-separated list of origins such as http://localhost:5173, or file://',
      '--allowed-origins',
    );
  }

  const absolute = (path: string) => resolve(process.cwd, expandHome(path, process.home));
  return {
    ok: true,
    settings: {
      host,
      port,
      dataDirectory: { ...dataDirectory, value: absolute(dataDirectory.value) },
      webRoot:
        webRootFlag !== undefined
          ? { ...webRootFlag, value: absolute(webRootFlag.value) }
          : bundled.webRoot !== undefined
            ? { value: bundled.webRoot, source: 'default', name: 'default' }
            : undefined,
      allowedOrigins,
    },
  };
}

/** `file://`, or exactly an `http:`/`https:` URL's origin: no path, query, credentials or slash. */
function isAllowedOrigin(entry: string): boolean {
  if (entry === 'file://') return true;
  try {
    const url = new URL(entry);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === entry;
  } catch {
    return false;
  }
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  return path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

function refused(
  setting: string,
  value: SourcedValue<string>,
  rule: string,
  flagName: `--${string}`,
): { readonly ok: false; readonly failure: CliFailure } {
  return {
    ok: false,
    failure: CliFailure.of(
      'cli_usage_invalid',
      `${value.name} must be ${rule}, got "${value.value}".`,
      {
        context: { [setting]: value },
        recovery:
          value.source === 'env'
            ? `Set ${value.name} to ${rule}, or pass ${flagName}.`
            : `Pass ${flagName} ${rule}.`,
      },
    ),
  };
}
