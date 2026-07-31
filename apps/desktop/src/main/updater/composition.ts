import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute, dirname } from 'node:path';
import process from 'node:process';

import { Effect } from 'effect';
import type { App } from 'electron';

import {
  UpdaterCoordinator,
  createStaticUpdaterService,
  systemUpdaterTimers,
  type DesktopUpdaterService,
} from './coordinator.js';
import { createUpdaterDiagnosticSink, type UpdaterDiagnosticSink } from './diagnostics.js';
import { loadElectronUpdater } from './load-electron-updater.js';
import { createRestartReadinessReader } from './restart-readiness.js';

export async function composeDesktopUpdater(
  application: Pick<App, 'getPath' | 'getVersion' | 'isPackaged'>,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly environment?: NodeJS.ProcessEnv;
    readonly diagnostics?: UpdaterDiagnosticSink;
    readonly loadUpdater?: typeof loadElectronUpdater;
    readonly getRuntimeUrl?: () => Effect.Effect<string, unknown>;
    readonly isExitCommitted?: () => boolean;
    readonly requestInstall?: () => void;
  } = {},
): Promise<DesktopUpdaterService> {
  const installedVersion = application.getVersion();
  if (!application.isPackaged)
    return createStaticUpdaterService(installedVersion, { state: 'disabled' });

  const platform = options.platform ?? process.platform;
  const diagnostics =
    options.diagnostics ?? createUpdaterDiagnosticSink(application.getPath('logs'));
  if (platform !== 'darwin' && platform !== 'linux') {
    return createStaticUpdaterService(installedVersion, { state: 'disabled' });
  }

  if (platform === 'linux') {
    const eligibility = await appImageEligibility(options.environment ?? process.env);
    if (!eligibility.eligible) {
      await diagnostics.write({
        operation: 'composition',
        platform,
        installedVersion,
        code: eligibility.code,
        summary: eligibility.summary,
      });
      // This is the one composition where the download page is reachable, so it
      // receives the real sink and can persist a rejected launch.
      return createStaticUpdaterService(installedVersion, {
        state: 'manual_update_required',
        diagnostics,
        platform,
      });
    }
  }

  const readRestartReadiness = createRestartReadinessReader({
    getRuntimeUrl:
      options.getRuntimeUrl ??
      (() => Effect.fail(new Error('Runtime access is not configured for update readiness.'))),
    diagnose: (category) => {
      void diagnostics.write({
        operation: 'readiness',
        platform,
        installedVersion,
        code: `restart_readiness_${category}`,
        summary: `Restart readiness failed during ${category}.`,
      });
    },
  });
  return new UpdaterCoordinator({
    updater: (options.loadUpdater ?? loadElectronUpdater)(),
    timers: systemUpdaterTimers,
    diagnostics,
    platform,
    installedVersion,
    readRestartReadiness,
    isExitCommitted: options.isExitCommitted ?? (() => false),
    requestInstall: options.requestInstall ?? (() => undefined),
  });
}

type AppImageEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly code: string; readonly summary: string };

export async function appImageEligibility(
  environment: NodeJS.ProcessEnv,
): Promise<AppImageEligibility> {
  const path = environment.APPIMAGE;
  if (!path) return ineligible('appimage_environment_missing', 'APPIMAGE is not set.');
  if (!isAbsolute(path)) return ineligible('appimage_path_relative', 'APPIMAGE is not absolute.');
  try {
    const information = await stat(path);
    if (!information.isFile())
      return ineligible('appimage_not_regular_file', 'APPIMAGE is not a regular file.');
    await access(path, constants.R_OK);
  } catch {
    return ineligible('appimage_unreadable', 'APPIMAGE is not a readable regular file.');
  }
  try {
    await access(dirname(path), constants.W_OK);
  } catch {
    return ineligible(
      'appimage_parent_unwritable',
      'The APPIMAGE parent directory is not writable.',
    );
  }
  return { eligible: true };
}

function ineligible(code: string, summary: string): AppImageEligibility {
  return { eligible: false, code, summary };
}
