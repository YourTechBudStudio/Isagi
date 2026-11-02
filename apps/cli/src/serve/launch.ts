/**
 * The `serve` → runtime seam. Only plain data crosses it: the runtime imports these as types, and
 * `serve` imports the runtime module only through a `RuntimeEntry`, so no other command loads the
 * runtime or its native modules.
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

export interface RuntimeEntryModule {
  /** Starts the runtime as the process's main program; it owns signals and exit from here. */
  readonly serveRuntime: (launch: RuntimeLaunch) => void;
}

/** How `serve` finds the runtime: injected by `bin.ts`, the runtime's source launcher and tests. */
export interface RuntimeEntry {
  readonly load: () => Promise<unknown>;
  /** The CLI file the runtime's shim runs. */
  readonly cliEntryPath: string;
  /** The web build shipped beside this entry; the `--web-root` default. */
  readonly defaultWebRoot?: string;
}
