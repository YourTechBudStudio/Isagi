import { privateRuntimeEnvironmentKeys } from '../../../../scripts/dev-supervisor/dev-protocol.mjs';

/**
 * How a managed runtime is launched: `isagi.mjs serve` with the desktop's
 * settings as flags, and an environment carrying only what is not a `serve`
 * setting.
 *
 * Only the managed target reaches this module. A runtime attached through
 * `ISAGI_RUNTIME_URL` is not spawned by the desktop at all, so it inherits
 * nothing from here.
 */

/**
 * Drops inherited desktop-owned and private orchestration values, so an
 * operator's stray value cannot reach a runtime the desktop did not intend it
 * for. The supervisor's private keys and `VITE_ISAGI_RUNTIME_URL` are removed
 * with no replacement, because a managed runtime has no business reading them.
 *
 * `ISAGI_HOST`/`ISAGI_PORT` pass through on purpose: the desktop passes no
 * `--host`/`--port`, so the user's own settings apply by precedence, and a
 * non-loopback host fails readiness with a hint naming them.
 */
export function sanitizeManagedRuntimeEnvironment(environment: NodeJS.ProcessEnv) {
  const sanitized = { ...environment };
  for (const key of privateRuntimeEnvironmentKeys) delete sanitized[key];
  delete sanitized.VITE_ISAGI_RUNTIME_URL;
  return sanitized;
}

/**
 * The single assembler for a managed runtime's spawn environment: the
 * sanitized inherited values plus `ELECTRON_RUN_AS_NODE`, so Electron's binary
 * runs `isagi.mjs` as Node. Every other setting is a `serve` flag.
 */
export function managedRuntimeSpawnEnvironment(input: {
  readonly inherited: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  return {
    ...sanitizeManagedRuntimeEnvironment(input.inherited),
    ELECTRON_RUN_AS_NODE: '1',
  };
}

/**
 * The `isagi.mjs` arguments for a managed runtime. A flag outranks any
 * inherited `ISAGI_DATA_DIR`, so the desktop's data directory always wins;
 * with none (a packaged app without an override) `serve` applies its own
 * `ISAGI_DATA_DIR`, then `~/.isagi`.
 *
 * `--web-root` names the desktop's own web build. The runtime serves it only
 * when the user's `config.yaml` sets `server.serveWebUi`; the desktop never
 * sets it.
 */
export function managedRuntimeServeArguments(input: {
  readonly allowedOrigins: string;
  readonly dataDirectory: string | undefined;
  readonly webRoot: string;
}): string[] {
  return [
    'serve',
    '--allowed-origins',
    input.allowedOrigins,
    ...(input.dataDirectory ? ['--data-dir', input.dataDirectory] : []),
    '--web-root',
    input.webRoot,
  ];
}
