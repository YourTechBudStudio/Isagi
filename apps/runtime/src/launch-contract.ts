/**
 * The `isagi serve` → runtime seam, owned by the runtime and exported as `@isagi/runtime/launch`. Only plain data
 * crosses it: the CLI imports these as types, and `serve` imports the runtime module lazily, so no other command loads
 * the runtime or its native modules. This file has no imports, so the CLI's typecheck reaches nothing else here.
 */

export type SettingSource = 'flag' | 'env' | 'config' | 'default';

export interface SourcedValue<A> {
  readonly value: A;
  readonly source: SettingSource;
  /** What the user wrote: '--port', 'ISAGI_PORT', 'server.port', or 'default'. */
  readonly name: string;
}

export interface RuntimeLaunch {
  /** Flag or env only; undefined means "config.yaml, then default" (resolved by the runtime). */
  readonly host: SourcedValue<string> | undefined;
  readonly port: SourcedValue<number> | undefined;
  /** Absolute; flag, env or default. Never read by the CLI. */
  readonly dataDirectory: SourcedValue<string>;
  /** Absolute; `--web-root`, else the copy bundled with this `isagi` (source `default`), else none. */
  readonly webRoot: SourcedValue<string> | undefined;
  readonly allowedOrigins: readonly string[];
  /** The CLI file the runtime's shim runs. */
  readonly cliEntryPath: string;
  /**
   * The desktop's private bearer token, from `ISAGI_LAUNCHER_TOKEN` (trimmed; unset or empty is none), removed from
   * the environment before the runtime loads. Never a flag, so it never appears in a process list.
   *
   * A plain string, like everything on this seam: the CLI and the runtime ship as separate bundles, each with its own
   * copy of `effect`, and a `Redacted` made by one copy cannot be read by the other. The runtime wraps it at once.
   */
  readonly launcherToken: string | undefined;
}

/** What the runtime module exports for `serve` to start. */
export interface RuntimeEntryModule {
  /** Starts the runtime as the process's main program; it owns signals and exit from here. */
  readonly serveRuntime: (launch: RuntimeLaunch) => void;
}
