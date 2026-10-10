import {
  Data,
  Duration,
  Effect,
  FiberHandle,
  FiberSet,
  Queue,
  Schedule,
  Semaphore,
  Stream,
} from 'effect';
import { HttpClient } from 'effect/http';

import type { DesktopUpdateSnapshot } from '@isagi/contracts';

import { DesktopUpdaterConfig, type UpdaterEvent, type UpdaterListener } from './config.js';
import {
  makeTrackedDiagnosticWrites,
  UpdaterDiagnostics,
  type UpdaterDiagnosticRecord,
} from './diagnostics.js';
import {
  readRestartReadiness,
  type RestartReadinessDiagnosticCategory,
} from './restart-readiness.js';
import type { DesktopUpdater } from './service.js';
import { makeSnapshotStore } from './snapshot-store.js';

export const updaterSchedule = {
  repeatCheck: Duration.hours(4),
  upToDate: Duration.seconds(5),
} as const;

type UpdateInfo = { readonly version: string };
type ProgressInfo = { readonly percent: number };

/**
 * Two independent facts about one in-flight operation, because the three ways a
 * check can start need three different answers:
 *
 * - the launch check announces itself (`checking…` is how the user learns Isagi
 *   looks at all) but its failure is not theirs to see, because they did not ask;
 * - the four-hourly poll announces nothing and reports nothing;
 * - a check the user pressed does both.
 */
type ActiveOperation = {
  readonly generation: number;
  phase: 'check' | 'download';
  /** Publishes the in-flight state, so the rail says what is happening. */
  readonly announce: boolean;
  /** The user asked for this, so its outcome — either way — is theirs to see. */
  readonly manual: boolean;
};

/** One electron-updater event, in the order the updater emitted it. */
type UpdaterSignal = { readonly event: UpdaterEvent; readonly value: unknown };

/** `checkForUpdates()` / `downloadUpdate()` rejected; `cause` is the updater's own error. */
class UpdaterOperationRejected extends Data.TaggedError('UpdaterOperationRejected')<{
  readonly cause: unknown;
}> {}

const DOWNLOAD_PAGE_FAILURE = {
  code: 'download_page_rejected',
  summary: 'The release download page could not be opened.',
} as const;

/**
 * The self-updating composition: electron-updater driven by the policy below.
 *
 * Building it is starting it. It looks immediately, and never downloads on its own.
 *
 * Both halves answer the same complaint: an update the user was never told
 * about. The check runs at launch rather than on a timer, so the rail has the
 * answer by the time they have finished looking at the window; and
 * `autoDownload` is off, so finding an update produces news to act on instead
 * of a silent ~150MB fetch whose only visible trace is the state after it.
 *
 * Every event handler and intent body runs under one lock, in arrival order, so
 * the policy reads and writes its state without interleaving. Closing the scope
 * is `stop`: late events are ignored, listeners are detached, the schedule and
 * the transient are interrupted, and diagnostic writes still in flight finish.
 */
export const makeSelfUpdatingUpdater = Effect.gen(function* () {
  const config = yield* DesktopUpdaterConfig;
  const diagnostics = yield* UpdaterDiagnostics;
  const httpClient = yield* HttpClient.HttpClient;
  const { installedVersion, platform } = config;
  const updater = config.loadUpdater();
  const store = yield* makeSnapshotStore({ state: 'idle', installedVersion });
  const lock = yield* Semaphore.make(1);
  const serialized = <A>(effect: Effect.Effect<A>) => Semaphore.withPermits(lock, 1)(effect);
  const diagnosticWrites = yield* makeTrackedDiagnosticWrites(diagnostics);
  /** In-flight `checkForUpdates()` / `downloadUpdate()` promises. */
  const operations = yield* FiberSet.make<void, never>();
  /** The pending return from `up_to_date` to `idle`. */
  const transient = yield* FiberHandle.make<void, never>();

  let generation = 0;
  let stopped = false;
  let active: ActiveOperation | undefined;
  let readinessGeneration: number | undefined;

  const ownsGeneration = (candidate: number) => !stopped && candidate === generation;
  const ownsActiveGeneration = () => (active ? ownsGeneration(active.generation) : false);

  const targetVersion = () => {
    const snapshot = store.current();
    return 'targetVersion' in snapshot ? (snapshot.targetVersion ?? '') : '';
  };

  const record = (
    operation: 'check' | 'download' | 'lifecycle',
    code: string,
    summary: string,
  ): UpdaterDiagnosticRecord => ({
    operation,
    platform,
    installedVersion,
    ...(targetVersion() ? { targetVersion: targetVersion() } : {}),
    code,
    summary,
  });

  const writeDiagnostic = (
    operation: 'check' | 'download' | 'lifecycle',
    code: string,
    error: unknown,
  ) => Effect.suspend(() => diagnosticWrites.start(record(operation, code, errorMessage(error))));

  // Readiness records name no target version: the read is about the runtime, not the update.
  const diagnoseReadiness = (category: RestartReadinessDiagnosticCategory) =>
    diagnosticWrites.start({
      operation: 'readiness',
      platform,
      installedVersion,
      code: `restart_readiness_${category}`,
      summary: `Restart readiness failed during ${category}.`,
    });

  const handleFailure = Effect.fnUntraced(function* (
    operation: 'check' | 'download',
    code: string,
    error?: unknown,
  ) {
    const failed = active;
    if (!failed || !ownsGeneration(failed.generation)) return;
    active = undefined;
    // Read before the transition: the failure snapshot replaces the downloading
    // one, and the target version is only still available on the outgoing state.
    const failedVersion = targetVersion();
    yield* writeDiagnostic(operation, code, error);
    if (operation === 'check' && !failed.manual) {
      // A check the user did not ask for never spends the rail on its failure.
      // One that announced itself still has to take its own token back down —
      // otherwise the launch check leaves `checking…` on screen forever — but a
      // silent poll leaves the rail exactly as it found it, including an older
      // failure the user has not dealt with yet.
      if (failed.announce && store.current().state === 'checking')
        yield* store.publish({ state: 'idle', installedVersion });
      return;
    }
    yield* store.publish(
      operation === 'check'
        ? { state: 'failed', installedVersion, operation: 'check', code: 'check_failed' }
        : {
            state: 'failed',
            installedVersion,
            operation: 'download',
            code: 'download_failed',
            targetVersion: failedVersion,
          },
    );
  });

  /**
   * The check is over the moment an update is found. Nothing is in flight after
   * this, because nothing else happens until the user presses — so the active
   * operation is cleared rather than rolled into a download phase.
   */
  const onUpdateAvailable = Effect.fnUntraced(function* (value: unknown) {
    const current = active;
    if (!current || current.phase !== 'check' || !ownsGeneration(current.generation)) return;
    active = undefined;
    yield* store.publish({
      state: 'update_available',
      installedVersion,
      targetVersion: updateVersion(value),
    });
  });

  const clearUpToDate = Effect.suspend(() =>
    !active && store.current().state === 'up_to_date'
      ? store.publish({ state: 'idle', installedVersion })
      : Effect.void,
  );

  const onUpdateNotAvailable = Effect.fnUntraced(function* () {
    const current = active;
    if (!current || !ownsGeneration(current.generation)) return;
    active = undefined;
    if (current.manual) {
      yield* store.publish({ state: 'up_to_date', installedVersion });
      yield* FiberHandle.run(
        transient,
        Effect.sleep(updaterSchedule.upToDate).pipe(Effect.andThen(serialized(clearUpToDate))),
      );
    } else {
      yield* store.publish({ state: 'idle', installedVersion });
    }
  });

  const onDownloadProgress = Effect.fnUntraced(function* (value: unknown) {
    if (!active || active.phase !== 'download' || !ownsActiveGeneration()) return;
    yield* store.publish({
      state: 'downloading',
      installedVersion,
      targetVersion: targetVersion(),
      progressPercent: normalizedProgress(value),
    });
  });

  const onUpdateDownloaded = Effect.fnUntraced(function* (value: unknown) {
    if (!active || active.phase !== 'download' || !ownsActiveGeneration()) return;
    const downloadedVersion = updateVersion(value) || targetVersion();
    active = undefined;
    yield* store.publish({ state: 'ready', installedVersion, targetVersion: downloadedVersion });
  });

  const onError = (error: unknown) =>
    Effect.suspend(() => {
      if (!active || !ownsActiveGeneration())
        return writeDiagnostic('lifecycle', 'idle_error', error);
      return handleFailure(active.phase, 'updater_error', error);
    });

  const handle = (signal: UpdaterSignal): Effect.Effect<void> => {
    switch (signal.event) {
      case 'error':
        return onError(signal.value);
      case 'update-available':
        return onUpdateAvailable(signal.value);
      case 'update-not-available':
        return onUpdateNotAvailable();
      case 'download-progress':
        return onDownloadProgress(signal.value);
      case 'update-downloaded':
        return onUpdateDownloaded(signal.value);
      case 'update-cancelled':
        return handleFailure('download', 'update_cancelled');
    }
  };

  /**
   * Runs `checkForUpdates()` / `downloadUpdate()` outside the lock. A rejection
   * is a failure of the operation it started only while that operation is still
   * the active one; otherwise an event has already settled it.
   */
  const runOperation = (
    phase: 'check' | 'download',
    started: number,
    code: 'check_rejected' | 'download_rejected',
    operation: () => Promise<unknown>,
  ) =>
    FiberSet.run(
      operations,
      Effect.tryPromise({
        try: operation,
        catch: (cause) => new UpdaterOperationRejected({ cause }),
      }).pipe(
        Effect.asVoid,
        Effect.catchTag('UpdaterOperationRejected', (rejection) =>
          serialized(
            Effect.suspend(() =>
              !active || active.phase !== phase || !ownsGeneration(started)
                ? Effect.void
                : handleFailure(phase, code, rejection.cause),
            ),
          ),
        ),
      ),
    );

  /**
   * The lock here is only the restart one, deliberately narrower than the
   * scheduled path's: a check the user pressed is allowed to run from a state a
   * timer may not disturb, because they asked and a timer did not.
   */
  const beginCheck = Effect.fnUntraced(function* (options: {
    readonly announce: boolean;
    readonly manual: boolean;
  }) {
    if (stopped || active || isRestartLocked(store.current())) return;
    yield* FiberHandle.clear(transient);
    const started = generation;
    active = { generation: started, phase: 'check', ...options };
    if (options.announce) yield* store.publish({ state: 'checking', installedVersion });
    yield* runOperation('check', started, 'check_rejected', () => updater.checkForUpdates());
  });

  const beginDownload = Effect.fnUntraced(function* () {
    if (stopped || active) return;
    const version = downloadableVersion(store.current());
    if (version === undefined) return;
    yield* FiberHandle.clear(transient);
    const started = generation;
    active = { generation: started, phase: 'download', announce: true, manual: true };
    yield* store.publish({
      state: 'downloading',
      installedVersion,
      targetVersion: version,
      progressPercent: 0,
    });
    yield* runOperation('download', started, 'download_rejected', () => updater.downloadUpdate());
  });

  const runScheduledCheck = Effect.suspend(() =>
    suppressesScheduledCheck(store.current())
      ? Effect.void
      : beginCheck({ announce: false, manual: false }),
  );

  const quitAndInstall = () => updater.quitAndInstall();

  const beginInstallation = Effect.suspend(() => {
    const snapshot = store.current();
    if (
      stopped ||
      (snapshot.state !== 'ready' && snapshot.state !== 'restart_confirmation') ||
      config.isExitCommitted()
    )
      return Effect.void;
    return store
      .publish({ state: 'installing', installedVersion, targetVersion: snapshot.targetVersion })
      .pipe(Effect.andThen(Effect.sync(() => config.requestInstall(quitAndInstall))));
  });

  const readiness = readRestartReadiness(config.runtimeUrl, diagnoseReadiness).pipe(
    Effect.provideService(HttpClient.HttpClient, httpClient),
  );

  // The lock is held for the begin and finish sections only, never across the
  // readiness read: events and other intents keep flowing while it is in flight.
  const requestRestart = Effect.gen(function* () {
    const claimed = yield* serialized(
      Effect.sync(() => {
        if (
          stopped ||
          store.current().state !== 'ready' ||
          readinessGeneration !== undefined ||
          config.isExitCommitted()
        )
          return undefined;
        readinessGeneration = generation;
        return generation;
      }),
    );
    if (claimed === undefined) return;
    // The marker is single-flight state, not a result. Clearing it in a
    // finalizer keeps a defect or an interrupted read from latching restart
    // off for the rest of the session.
    yield* Effect.gen(function* () {
      const answer = yield* readiness;
      yield* serialized(
        Effect.suspend(() => {
          const snapshot = store.current();
          if (!ownsGeneration(claimed) || snapshot.state !== 'ready' || config.isExitCommitted())
            return Effect.void;
          if (answer.kind === 'clear') return beginInstallation;
          return store.publish({
            state: 'restart_confirmation',
            installedVersion,
            targetVersion: snapshot.targetVersion,
            activity:
              answer.kind === 'working_agents'
                ? { kind: 'working', workingAgentCount: answer.workingAgentCount }
                : { kind: 'unknown' },
          });
        }),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (readinessGeneration === claimed) readinessGeneration = undefined;
        }),
      ),
    );
  });

  // Start: configure the updater, attach its listeners, announce the launch
  // check, and arm the four-hourly poll.
  updater.allowPrerelease = false;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;

  // Listeners only enqueue; one consumer applies the events in arrival order
  // under the lock. They are attached here, before the launch check goes out,
  // and detached when the scope closes.
  const signals = yield* Queue.unbounded<UpdaterSignal>();
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      updaterEvents.map((event) => {
        const listener: UpdaterListener = (value) => {
          Queue.offerUnsafe(signals, { event, value });
        };
        updater.on(event, listener);
        return [event, listener] as const;
      }),
    ),
    (listeners) =>
      Effect.sync(() => {
        for (const [event, listener] of listeners) updater.off(event, listener);
      }),
  );
  yield* Stream.fromQueue(signals).pipe(
    Stream.runForEach((signal) => serialized(handle(signal))),
    Effect.forkScoped,
  );

  // Announced but not manual: the user sees that Isagi looked, and does not
  // see a failure they did not ask for.
  yield* serialized(beginCheck({ announce: true, manual: false }));
  // setInterval semantics: the first scheduled check runs one period after launch.
  yield* serialized(runScheduledCheck).pipe(
    Effect.schedule(Schedule.spaced(updaterSchedule.repeatCheck)),
    Effect.forkScoped,
  );

  // Registered last, so it runs first: nothing in flight may own a generation
  // once stopping has begun.
  yield* Effect.addFinalizer(() =>
    serialized(
      Effect.sync(() => {
        stopped = true;
        generation += 1;
        active = undefined;
        readinessGeneration = undefined;
      }),
    ),
  );

  const service: DesktopUpdater['Service'] = {
    status: store.status,
    checkForUpdates: serialized(beginCheck({ announce: true, manual: true })).pipe(
      Effect.withSpan('DesktopUpdater.checkForUpdates'),
    ),
    /**
     * Fetches the update the last check found. Only the user starts this, which is
     * why it is an intent of its own rather than something `update_available`
     * drifts into on a timer.
     *
     * A failed download is a legal starting point as well as `update_available`:
     * the provider still knows what it found, so the retry is another download
     * rather than a second round trip through the check.
     */
    downloadUpdate: serialized(beginDownload()).pipe(
      Effect.withSpan('DesktopUpdater.downloadUpdate'),
    ),
    requestRestart: requestRestart.pipe(Effect.withSpan('DesktopUpdater.requestRestart')),
    confirmRestart: serialized(
      Effect.suspend(() =>
        store.current().state === 'restart_confirmation' ? beginInstallation : Effect.void,
      ),
    ).pipe(Effect.withSpan('DesktopUpdater.confirmRestart')),
    cancelRestart: serialized(
      Effect.suspend(() => {
        const snapshot = store.current();
        if (snapshot.state !== 'restart_confirmation' || config.isExitCommitted())
          return Effect.void;
        return store.publish({
          state: 'ready',
          installedVersion,
          targetVersion: snapshot.targetVersion,
        });
      }),
    ).pipe(Effect.withSpan('DesktopUpdater.cancelRestart')),
    /**
     * A composition that runs the real updater never publishes
     * `manual_update_required`, so there is no snapshot here for an outcome to land
     * on and nothing for attempts to race over. The diagnostic is still written: an
     * intent that reached a self-updating build at all is worth a line in the trail.
     */
    beginDownloadPageAttempt: Effect.succeed((outcome) =>
      outcome === 'opened'
        ? Effect.void
        : Effect.suspend(() =>
            diagnosticWrites.complete(
              record('lifecycle', DOWNLOAD_PAGE_FAILURE.code, DOWNLOAD_PAGE_FAILURE.summary),
            ),
          ),
    ),
    installer: {
      quitAndInstall,
      // Written straight to the trail, not through the scope's tracked writes:
      // this runs after the desktop runtime has been disposed.
      recordInstallRejection: Effect.suspend(() =>
        diagnostics.write(
          record(
            'lifecycle',
            'exit_rejection',
            'The update installer rejected after desktop shutdown.',
          ),
        ),
      ),
    },
  };
  return service;
});

const updaterEvents: readonly UpdaterEvent[] = [
  'error',
  'update-available',
  'update-not-available',
  'download-progress',
  'update-downloaded',
  'update-cancelled',
];

/**
 * The version a download may be started for, or `undefined` when there is
 * nothing to fetch. Read from the snapshot rather than held beside it, so the
 * fact the user is looking at is the fact the download acts on.
 */
function downloadableVersion(snapshot: DesktopUpdateSnapshot) {
  if (snapshot.state === 'update_available') return snapshot.targetVersion;
  if (snapshot.state === 'failed' && snapshot.operation === 'download')
    return snapshot.targetVersion;
  return undefined;
}

/**
 * States a *scheduled* check may not interrupt. Two reasons, one rule.
 *
 * A restart in flight must not have the rail changed underneath it.
 *
 * And a download the user has not started yet — offered, or offered again after
 * a failure — is a live control they may press at any moment. A background check
 * that quietly claimed the in-flight slot would make that press do nothing at
 * all, and do it invisibly: the check announces nothing, so the control stays
 * enabled, and when it finishes it republishes facts the rail already has, which
 * pushes no revision for the client to recover on. The user would be left
 * pressing a button that works most of the time.
 *
 * Waiting costs nothing here. The version is already known, so there is nothing
 * a fresh check could tell the user that the rail is not already showing them.
 *
 * A failed *check* is deliberately absent: there the poll is exactly what
 * quietly heals the rail, and a press landing on an in-flight check still gets
 * the answer it asked for, only without the `checking…` token.
 */
function suppressesScheduledCheck(snapshot: DesktopUpdateSnapshot) {
  return downloadableVersion(snapshot) !== undefined || isRestartLocked(snapshot);
}

function isRestartLocked(snapshot: DesktopUpdateSnapshot) {
  return (
    snapshot.state === 'ready' ||
    snapshot.state === 'restart_confirmation' ||
    snapshot.state === 'installing'
  );
}

function updateVersion(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('version' in value)) return '';
  return typeof (value as UpdateInfo).version === 'string' ? (value as UpdateInfo).version : '';
}

function normalizedProgress(value: unknown): number {
  const percent =
    typeof value === 'object' && value !== null && 'percent' in value
      ? Number((value as ProgressInfo).percent)
      : 0;
  return Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown updater failure.';
}
