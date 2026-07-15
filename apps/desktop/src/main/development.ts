import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { app } from 'electron';

import {
  developmentEnvironmentKeys,
  developmentPaths,
} from '../../../../scripts/dev-supervisor/dev-protocol.mjs';

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

export function configureDevelopmentUserData(repositoryRoot: string) {
  const root = resolveDevelopmentRoot(repositoryRoot);
  const userData = developmentPaths(root).userData;
  app.setPath('userData', userData);
  console.info(`[desktop] Electron profile ${userData}`);
  return root;
}
