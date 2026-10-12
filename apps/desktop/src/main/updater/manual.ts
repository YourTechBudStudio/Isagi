import { Effect } from 'effect';

import { DesktopUpdaterConfig } from './config.js';
import { makeTrackedDiagnosticWrites, UpdaterDiagnostics } from './diagnostics.js';
import type { DownloadPageOutcome } from './download-page.js';
import type { DesktopUpdater } from './service.js';
import { makeSnapshotStore } from './snapshot-store.js';

const DOWNLOAD_PAGE_FAILURE = {
  code: 'download_page_rejected',
  summary: 'The release download page could not be opened.',
} as const;

/** What a build with no updater answers to every update intent: nothing happens. */
const inertIntents = {
  checkForUpdates: Effect.void,
  downloadUpdate: Effect.void,
  requestRestart: Effect.void,
  confirmRestart: Effect.void,
  cancelRestart: Effect.void,
  installer: { quitAndInstall: () => undefined, recordInstallRejection: Effect.void },
} as const;

/**
 * A build with no updater at all (development, unsupported platforms). It can be asked to do
 * nothing, and its snapshot never changes.
 */
export const makeDisabledUpdater = Effect.gen(function* () {
  const { installedVersion } = yield* DesktopUpdaterConfig;
  const store = yield* makeSnapshotStore({ installedVersion, state: 'disabled' });
  const service: DesktopUpdater['Service'] = {
    ...inertIntents,
    status: store.status,
    // A development build shows no manual-install action, so no outcome has anywhere to land.
    beginDownloadPageAttempt: Effect.succeed(() => Effect.void),
  };
  return service;
});

/**
 * The build that cannot replace itself. It runs no updater and reaches no
 * provider, so its state never changes on its own — but it is not inert: opening
 * the release page is a real operation the user owns, and whether it opened is
 * the one fact this composition can still learn and has to report.
 *
 * It publishes that outcome onto the same snapshot every other update state
 * arrives on, rather than answering the intent directly, so the renderer keeps a
 * single source of update truth and the failure survives a reload or a second
 * window instead of living in one promise's resolution.
 */
export const makeManualUpdater = Effect.gen(function* () {
  const { installedVersion, platform } = yield* DesktopUpdaterConfig;
  const diagnostics = yield* UpdaterDiagnostics;
  const diagnosticWrites = yield* makeTrackedDiagnosticWrites(diagnostics);
  const store = yield* makeSnapshotStore({
    installedVersion,
    state: 'manual_update_required',
    reason: 'unsupported_installation',
    openFailure: null,
  });
  /** The most recently claimed attempt. Only it may speak for the snapshot. */
  let attempts = 0;

  const report = Effect.fnUntraced(function* (attempt: number, outcome: DownloadPageOutcome) {
    // Latest press wins. A launch the user has already superseded may not speak
    // for the rail, whichever way it went — but it is still a real thing that
    // happened, so a superseded failure keeps its line in the diagnostic trail.
    if (attempt === attempts) {
      // Published before the diagnostic is awaited: the user is waiting on the
      // rail, and a slow or broken log must not delay or suppress the answer.
      yield* store.publish({
        installedVersion,
        state: 'manual_update_required',
        reason: 'unsupported_installation',
        openFailure: outcome === 'failed' ? 'download_page_open_failed' : null,
      });
    }
    if (outcome === 'opened') return;
    yield* diagnosticWrites.complete({
      operation: 'lifecycle',
      platform,
      installedVersion,
      code: DOWNLOAD_PAGE_FAILURE.code,
      summary: DOWNLOAD_PAGE_FAILURE.summary,
    });
  });

  const service: DesktopUpdater['Service'] = {
    ...inertIntents,
    status: store.status,
    beginDownloadPageAttempt: Effect.sync(() => {
      attempts += 1;
      const attempt = attempts;
      return (outcome: DownloadPageOutcome) => report(attempt, outcome);
    }),
  };
  return service;
});
