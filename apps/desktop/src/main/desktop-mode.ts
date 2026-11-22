// How this desktop process was started, and where its data lives. Pure, so every mode is testable without Electron;
// `index.ts`, `runtime.ts` and the theme read all take their answers from here, so the window and the managed runtime
// always agree on the data directory, and so on the `config.yaml` they read.
import { join } from 'node:path';

import { normalizeHomePath, resolveDataDirectory } from '@isagi/shared/global-config';

import { developmentPaths } from '../../../../scripts/dev-supervisor/dev-protocol.mjs';

/**
 * - `packaged`: an installed app. The runtime serves the packaged web build.
 * - `unpackaged`: `electron .` from a checkout without `ISAGI_WEB_URL`: the production path (the runtime serves
 *   `apps/web/dist`), used by the end-to-end suite and by hand.
 * - `development`: the dev supervisor's run: `ISAGI_WEB_URL` names the Vite dev server, which proxies to the runtime.
 *   `ISAGI_WEB_URL` is the only switch into it.
 */
export type DesktopMode =
  | { readonly kind: 'packaged' }
  | { readonly kind: 'unpackaged' }
  | { readonly kind: 'development'; readonly webUrl: string };

export function resolveDesktopMode(input: {
  readonly isPackaged: boolean;
  readonly webUrl: string | undefined;
}): DesktopMode {
  if (input.isPackaged) return { kind: 'packaged' };
  return input.webUrl ? { kind: 'development', webUrl: input.webUrl } : { kind: 'unpackaged' };
}

/**
 * The one data directory of this desktop run, always passed to the managed runtime as `--data-dir`:
 * - packaged: `ISAGI_DATA_DIR`, else the shared default (`~/.isagi`);
 * - unpackaged: `ISAGI_DATA_DIR`, else the checkout's development data root;
 * - development: the checkout's development data root, ignoring an inherited `ISAGI_DATA_DIR`, so a developer's
 *   real data directory is never what a dev run writes to.
 */
export function resolveDesktopDataDirectory(input: {
  readonly mode: DesktopMode;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The checkout root (`resolveDevelopmentRoot`); read only when unpackaged. */
  readonly developmentRoot: () => string;
  readonly home?: string;
}): string {
  const configured = input.env.ISAGI_DATA_DIR;
  switch (input.mode.kind) {
    case 'packaged':
      return resolveDataDirectory({ env: input.env, ...(input.home ? { home: input.home } : {}) });
    case 'unpackaged':
      return configured
        ? normalizeHomePath(configured, input.home)
        : developmentPaths(input.developmentRoot()).dataRoot;
    case 'development':
      return developmentPaths(input.developmentRoot()).dataRoot;
  }
}

/** Electron's profile for an unpackaged run: beside its data, so a fresh data directory is also a fresh profile. */
export function unpackagedUserDataDirectory(dataDirectory: string): string {
  return join(dataDirectory, 'electron-user-data');
}

/** The logs directory of an unpackaged run (the failure page's Open logs), beside its data like the profile. */
export function unpackagedLogsDirectory(dataDirectory: string): string {
  return join(dataDirectory, 'logs');
}
