import { createRequire } from 'node:module';

import type { UpdaterAdapter } from './config.js';

export function loadElectronUpdater(): UpdaterAdapter {
  const module = createRequire(import.meta.url)('electron-updater') as {
    readonly autoUpdater: UpdaterAdapter;
  };
  return module.autoUpdater;
}
