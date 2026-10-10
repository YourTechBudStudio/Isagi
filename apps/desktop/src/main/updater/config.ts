import process from 'node:process';

import { Context, Effect, Layer } from 'effect';
import type { App } from 'electron';

import type { RuntimeLifecycleFailure } from '../runtime-process/index.js';
import { loadElectronUpdater } from './load-electron-updater.js';

type UpdaterEvent =
  | 'error'
  | 'update-available'
  | 'update-not-available'
  | 'download-progress'
  | 'update-downloaded'
  | 'update-cancelled';
type UpdaterListener = (...args: unknown[]) => void;

/** The slice of electron-updater's `autoUpdater` the coordinator drives. */
export interface UpdaterAdapter {
  allowPrerelease: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: UpdaterEvent, listener: UpdaterListener): unknown;
  off(event: UpdaterEvent, listener: UpdaterListener): unknown;
}

export type { UpdaterEvent, UpdaterListener };

/**
 * Everything the updater needs from Electron and from the rest of main, as plain facts and
 * closures. The updater never imports the runtime-process service or the shutdown coordinator:
 * main wires them in here.
 */
export class DesktopUpdaterConfig extends Context.Service<
  DesktopUpdaterConfig,
  {
    readonly platform: NodeJS.Platform;
    readonly installedVersion: string;
    readonly isPackaged: boolean;
    readonly environment: NodeJS.ProcessEnv;
    /**
     * Read only when a diagnostic is first written. A build that never writes one (every
     * development build) never asks Electron for its logs path.
     */
    readonly logsDirectory: () => string;
    /** Called only by the self-updating composition, so other builds never load electron-updater. */
    readonly loadUpdater: () => UpdaterAdapter;
    /** True once main has committed to an exit; restart work stops being offered from then on. */
    readonly isExitCommitted: () => boolean;
    /** Hands the process to the installer through main's shutdown sequence. */
    readonly requestInstall: (install: () => void) => void;
    /** The runtime the restart-readiness read asks for agent activity. */
    readonly runtimeUrl: Effect.Effect<string, RuntimeLifecycleFailure>;
  }
>()('isagi/desktop/updater/DesktopUpdaterConfig') {
  /**
   * The configuration of the running app. `runtimeUrl` may need services (main passes
   * `RuntimeProcess.use((process) => process.url)`); they are captured when this layer builds, so
   * the configured effect has no requirements of its own.
   */
  static readonly layerElectron = <R = never>(
    application: Pick<App, 'getPath' | 'getVersion' | 'isPackaged'>,
    wiring: {
      readonly runtimeUrl: Effect.Effect<string, RuntimeLifecycleFailure, R>;
      readonly isExitCommitted: () => boolean;
      readonly requestInstall: (install: () => void) => void;
    },
  ): Layer.Layer<DesktopUpdaterConfig, never, R> =>
    Layer.effect(
      DesktopUpdaterConfig,
      Effect.gen(function* () {
        const context = yield* Effect.context<R>();
        return DesktopUpdaterConfig.of({
          platform: process.platform,
          installedVersion: application.getVersion(),
          isPackaged: application.isPackaged,
          environment: process.env,
          logsDirectory: () => application.getPath('logs'),
          loadUpdater: loadElectronUpdater,
          isExitCommitted: wiring.isExitCommitted,
          requestInstall: wiring.requestInstall,
          runtimeUrl: Effect.provideContext(wiring.runtimeUrl, context),
        });
      }),
    );
}
