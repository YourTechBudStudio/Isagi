import { Context, Effect, Layer, type SubscriptionRef } from 'effect';

import type { DesktopUpdateSnapshot } from '@isagi/contracts';

import { selectUpdaterComposition } from './composition.js';
import { makeSelfUpdatingUpdater } from './coordinator.js';
import type { DownloadPageOutcome } from './download-page.js';
import { makeDisabledUpdater, makeManualUpdater } from './manual.js';

/** Reports one claimed attempt. Calling it twice reports the same attempt twice. */
export type ReportDownloadPageOutcome = (outcome: DownloadPageOutcome) => Effect.Effect<void>;

/**
 * Desktop self-update: the snapshot the renderer's update rail shows, and the intents it sends.
 *
 * The layer's scope is the updater's lifetime. Building it starts the updater (configure, launch
 * check, four-hourly poll); closing it stops the updater and waits for diagnostic writes in flight.
 */
export class DesktopUpdater extends Context.Service<
  DesktopUpdater,
  {
    /** Current snapshot plus every change; the revision advances only with a visible fact. */
    readonly status: SubscriptionRef.SubscriptionRef<DesktopUpdateSnapshot>;
    readonly checkForUpdates: Effect.Effect<void>;
    readonly downloadUpdate: Effect.Effect<void>;
    /** Settles once the runtime activity read has resolved, which is what the user waits on. */
    readonly requestRestart: Effect.Effect<void>;
    readonly confirmRestart: Effect.Effect<void>;
    readonly cancelRestart: Effect.Effect<void>;
    /**
     * Claims the next download-page attempt and returns the only way to report it.
     * Opening the page is main's own operation, not the updater's, so the service
     * never navigates — but the outcome is updater state, and it lands on the same
     * snapshot the renderer already watches and the same diagnostic trail as every
     * other updater failure.
     *
     * Ownership is claimed here, when the user presses, rather than when the launch
     * settles. Two overlapping presses finish in whatever order the OS decides, and
     * `openFailure` means *the last attempt*, so an older completion must not be
     * able to overwrite a newer one's answer. The claim is what makes that order
     * knowable.
     *
     * Both outcomes are reported, not just the failure: a launch that succeeds is
     * what clears a previously published failure, so the user who retries and gets
     * a browser stops being told the action failed.
     */
    readonly beginDownloadPageAttempt: Effect.Effect<ReportDownloadPageOutcome>;
    /**
     * For main's shutdown sequence, which hands the process to the installer after the desktop
     * runtime is disposed: a plain closure, and a requirement-free effect main runs itself.
     */
    readonly installer: {
      readonly quitAndInstall: () => void;
      readonly recordInstallRejection: Effect.Effect<void>;
    };
  }
>()('isagi/desktop/updater/DesktopUpdater') {
  /** electron-updater, driven by the update policy. */
  static readonly layerSelfUpdating = Layer.effect(DesktopUpdater, makeSelfUpdatingUpdater);
  /** `manual_update_required`: only the release download page is reachable. */
  static readonly layerManual = Layer.effect(DesktopUpdater, makeManualUpdater);
  /** Inert, state `disabled`. */
  static readonly layerDisabled = Layer.effect(DesktopUpdater, makeDisabledUpdater);
  /** The composition this installation gets (`selectUpdaterComposition`). */
  static readonly layer = Layer.unwrap(
    selectUpdaterComposition.pipe(
      Effect.map((composition) => {
        switch (composition) {
          case 'disabled':
            return DesktopUpdater.layerDisabled;
          case 'manual_update_required':
            return DesktopUpdater.layerManual;
          case 'self_updating':
            return DesktopUpdater.layerSelfUpdating;
        }
      }),
    ),
  );
}
