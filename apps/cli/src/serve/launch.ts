/**
 * How `serve` finds the runtime. The launch contract it hands over (`RuntimeLaunch` and friends) is the runtime's,
 * imported as types from `@isagi/runtime/launch`, so `isagi.mjs` bundles none of the runtime.
 */

/** How `serve` finds the runtime: injected by `bin.ts`, the source launcher and tests. */
export interface RuntimeEntry {
  readonly load: () => Promise<unknown>;
  /** The CLI file the runtime's shim runs. */
  readonly cliEntryPath: string;
  /** The web build shipped beside this entry; the `--web-root` default. */
  readonly defaultWebRoot?: string;
}
