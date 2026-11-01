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
