import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute, dirname } from 'node:path';

import { Effect } from 'effect';

import { DesktopUpdaterConfig } from './config.js';
import { UpdaterDiagnostics } from './diagnostics.js';

/** Which updater this installation gets. */
export type UpdaterComposition = 'disabled' | 'manual_update_required' | 'self_updating';

/**
 * Only a packaged macOS build or a packaged Linux AppImage the user can replace may run
 * electron-updater; every other build gets an updater that never loads it.
 */
export const selectUpdaterComposition = Effect.gen(function* () {
  const config = yield* DesktopUpdaterConfig;
  if (!config.isPackaged) return 'disabled' as const;
  const { platform, installedVersion } = config;
  if (platform !== 'darwin' && platform !== 'linux') return 'disabled' as const;

  if (platform === 'linux') {
    const eligibility = yield* Effect.promise(() => appImageEligibility(config.environment));
    if (!eligibility.eligible) {
      const diagnostics = yield* UpdaterDiagnostics;
      yield* diagnostics.write({
        operation: 'composition',
        platform,
        installedVersion,
        code: eligibility.code,
        summary: eligibility.summary,
      });
      // This is the one composition where the download page is reachable, so it
      // receives the real trail and can persist a rejected launch.
      return 'manual_update_required' as const;
    }
  }
  return 'self_updating' as const;
}).pipe(Effect.withSpan('DesktopUpdater.selectComposition'));

type AppImageEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly code: string; readonly summary: string };

/** Never rejects: every filesystem failure is an ineligibility reason. */
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
