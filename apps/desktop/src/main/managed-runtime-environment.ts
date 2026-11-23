import { Redacted } from 'effect';

import { privateRuntimeEnvironmentKeys } from '../../../../scripts/dev-supervisor/dev-protocol.mjs';

/**
 * How a managed runtime is launched: `isagi.mjs serve` with the desktop's
 * settings as flags, and an environment carrying only what is not a `serve`
 * setting. The desktop only ever runs the runtime it launches.
 */

/**
 * Drops inherited desktop-owned and private orchestration values, so an
 * operator's stray value cannot reach a runtime the desktop did not intend it
 * for. The supervisor's private keys and `VITE_ISAGI_RUNTIME_URL` are removed
 * with no replacement, because a managed runtime has no business reading them.
 * An inherited `ISAGI_LAUNCHER_TOKEN` is removed too; the spawn environment
 * sets the desktop's own.
 *
 * `ISAGI_HOST`/`ISAGI_PORT` pass through on purpose: the desktop passes no
 * `--host`/`--port`, so the user's own settings apply by precedence, and a
 * non-loopback host fails readiness with a hint naming them.
 */
export function sanitizeManagedRuntimeEnvironment(environment: NodeJS.ProcessEnv) {
  const sanitized = { ...environment };
  for (const key of privateRuntimeEnvironmentKeys) delete sanitized[key];
  delete sanitized.VITE_ISAGI_RUNTIME_URL;
  delete sanitized.ISAGI_LAUNCHER_TOKEN;
  return sanitized;
}

/**
 * The single assembler for a managed runtime's spawn environment: the
 * sanitized inherited values, `ELECTRON_RUN_AS_NODE`, so Electron's binary
 * runs `isagi.mjs` as Node, and `ISAGI_LAUNCHER_TOKEN`, the bearer the runtime
 * admits for the desktop. The token travels only here, never in argv, so no
 * process list shows it, and `serve` removes it from its own environment
 * before the runtime loads. Every other setting is a `serve` flag.
 */
export function managedRuntimeSpawnEnvironment(input: {
  readonly inherited: NodeJS.ProcessEnv;
  readonly launcherToken: Redacted.Redacted<string>;
}): NodeJS.ProcessEnv {
  return {
    ...sanitizeManagedRuntimeEnvironment(input.inherited),
    ELECTRON_RUN_AS_NODE: '1',
    ISAGI_LAUNCHER_TOKEN: Redacted.value(input.launcherToken),
  };
}

/**
 * The `isagi.mjs` arguments for a managed runtime. `--data-dir` is always
 * passed: it is the directory the desktop resolved once (`desktop-mode.ts`) and
 * read its theme from, so the window and the runtime read the same
 * `config.yaml` and the runtime never resolves the path a second way.
 *
 * `--web-root` names the desktop's own web build, which the runtime serves at
 * its own origin and the window loads from there.
 *
 * `--allowed-origins` is passed only in development, where the window's
 * document comes from the Vite dev server rather than the runtime. A packaged
 * or unpackaged window is same-origin with the runtime and needs none.
 */
export function managedRuntimeServeArguments(input: {
  readonly allowedOrigins: string | undefined;
  readonly dataDirectory: string;
  readonly webRoot: string;
}): string[] {
  return [
    'serve',
    ...(input.allowedOrigins ? ['--allowed-origins', input.allowedOrigins] : []),
    '--data-dir',
    input.dataDirectory,
    '--web-root',
    input.webRoot,
  ];
}

/**
 * The browser origins a development runtime admits: the Vite dev server's, which the window loads, and any the
 * developer added through `ISAGI_ALLOWED_ORIGINS`, de-duplicated in order.
 */
export function developmentAllowedOrigins(input: {
  readonly webOrigin: string;
  readonly configuredAllowedOrigins: string | undefined;
}): string {
  const configured = input.configuredAllowedOrigins?.split(',') ?? [];
  return [
    ...new Set([input.webOrigin, ...configured.map((origin) => origin.trim()).filter(Boolean)]),
  ].join(',');
}
