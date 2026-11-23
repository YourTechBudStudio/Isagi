import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { app } from 'electron';

import { developmentEnvironmentKeys } from '../../../../scripts/dev-supervisor/dev-protocol.mjs';
import { unpackagedLogsDirectory, unpackagedUserDataDirectory } from './desktop-mode.js';

export function resolveDevelopmentRoot(repositoryRoot: string) {
  const configured = process.env[developmentEnvironmentKeys.worktreeRoot];
  const root = realpathSync(configured ? resolve(configured) : repositoryRoot);
  if (
    !existsSync(resolve(root, 'package.json')) ||
    !existsSync(resolve(root, 'apps/desktop/package.json'))
  ) {
    throw new Error(`ISAGI development root is not a valid checkout: ${root}`);
  }
  return root;
}

/**
 * Points Electron's profile and logs directory beside an unpackaged run's data directory (in development, the
 * checkout's `data/.isagi/electron-user-data`, as before, and `data/.isagi/logs`), so a fresh data directory is also a
 * fresh profile and a fresh place for the runtime failure record. Before `whenReady`.
 */
export function configureUnpackagedUserData(dataDirectory: string) {
  const userData = unpackagedUserDataDirectory(dataDirectory);
  app.setPath('userData', userData);
  app.setAppLogsPath(unpackagedLogsDirectory(dataDirectory));
  console.info(`[desktop] Electron profile ${userData}`);
}
