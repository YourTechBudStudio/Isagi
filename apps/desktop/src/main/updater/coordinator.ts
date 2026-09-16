import { Effect } from 'effect';

import { DESKTOP_UPDATE_PROTOCOL_VERSION, type DesktopUpdateSnapshot } from '@isagi/contracts';

import type { UpdaterDiagnosticSink } from './diagnostics.js';
import type { DownloadPageOutcome } from './download-page.js';

export const updaterSchedule = {
  repeatCheckMs: 4 * 60 * 60 * 1_000,
  upToDateMs: 5_000,
} as const;

type UpdateInfo = { readonly version: string };
type ProgressInfo = { readonly percent: number };
type UpdaterEvent =
  | 'error'
  | 'update-available'
  | 'update-not-available'
  | 'download-progress'
  | 'update-downloaded'
  | 'update-cancelled';
type UpdaterListener = (...args: unknown[]) => void;

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

export interface UpdaterTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface DesktopUpdaterService {
  readonly snapshot: DesktopUpdateSnapshot;
  subscribe(listener: (snapshot: DesktopUpdateSnapshot) => void): () => void;
  start(): Effect.Effect<void>;
  stop(): Effect.Effect<void>;
  checkForUpdates(): Effect.Effect<void>;
  downloadUpdate(): Effect.Effect<void>;
  requestRestart(): Effect.Effect<void>;
  confirmRestart(): Effect.Effect<void>;
  cancelRestart(): Effect.Effect<void>;
  quitAndInstall(): void;
  recordInstallRejection(): Promise<void>;
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
  beginDownloadPageAttempt(): ReportDownloadPageOutcome;
}

/** Reports one claimed attempt. Calling it twice reports the same attempt twice. */
export type ReportDownloadPageOutcome = (outcome: DownloadPageOutcome) => Promise<void>;

export type RestartReadiness = import('./restart-readiness.js').RestartReadiness;

type SnapshotFacts = DesktopUpdateSnapshot extends infer Snapshot
  ? Snapshot extends DesktopUpdateSnapshot
    ? Omit<Snapshot, 'protocolVersion' | 'revision'>
    : never
  : never;
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

/**
 * The published snapshot and its subscribers. Every service that can change what
 * the renderer sees owns one of these, because the revision rule is the whole
 * basis of the client's subscribe-then-reconcile: a revision that fails to
 * advance, or advances without a listener being told, is a renderer stuck on a
 * stale fact. One implementation, so the manual-install service cannot drift
 * from the coordinator on it.
 */
class SnapshotStore {
  readonly #listeners = new Set<(snapshot: DesktopUpdateSnapshot) => void>();
  #snapshot: DesktopUpdateSnapshot;
  #revision = 0;

  constructor(facts: SnapshotFacts) {
    this.#snapshot = {
      protocolVersion: DESKTOP_UPDATE_PROTOCOL_VERSION,
      revision: 0,
      ...facts,
    } as DesktopUpdateSnapshot;
  }

  get snapshot() {
    return this.#snapshot;
  }

  subscribe(listener: (snapshot: DesktopUpdateSnapshot) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  clearListeners() {
    this.#listeners.clear();
  }

  /** A publish that would change nothing is not a revision, so it is not a push. */
  publish(facts: SnapshotFacts) {
    const next = {
      protocolVersion: DESKTOP_UPDATE_PROTOCOL_VERSION,
      revision: this.#revision + 1,
      ...facts,
    } as DesktopUpdateSnapshot;
    if (sameFacts(this.#snapshot, next)) return;
    this.#revision += 1;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener(next);
  }
}

export class UpdaterCoordinator implements DesktopUpdaterService {
  readonly #updater: UpdaterAdapter;
  readonly #timers: UpdaterTimers;
  readonly #diagnostics: UpdaterDiagnosticSink;
  readonly #platform: string;
  readonly #installedVersion: string;
  readonly #readRestartReadiness: () => Effect.Effect<RestartReadiness>;
  readonly #isExitCommitted: () => boolean;
  readonly #requestInstall: () => void;
  readonly #store: SnapshotStore;
  #generation = 0;
  #started = false;
  #stopped = false;
  #active: ActiveOperation | undefined;
  #repeatCheckTimer: unknown;
  #transientTimer: unknown;
  #readinessGeneration: number | undefined;

  constructor(dependencies: {
    readonly updater: UpdaterAdapter;
    readonly timers: UpdaterTimers;
    readonly diagnostics: UpdaterDiagnosticSink;
    readonly platform: string;
    readonly installedVersion: string;
    readonly readRestartReadiness: () => Effect.Effect<RestartReadiness>;
    readonly isExitCommitted: () => boolean;
    readonly requestInstall: () => void;
  }) {
    this.#updater = dependencies.updater;
    this.#timers = dependencies.timers;
    this.#diagnostics = dependencies.diagnostics;
    this.#platform = dependencies.platform;
    this.#installedVersion = dependencies.installedVersion;
    this.#readRestartReadiness = dependencies.readRestartReadiness;
    this.#isExitCommitted = dependencies.isExitCommitted;
    this.#requestInstall = dependencies.requestInstall;
    this.#store = new SnapshotStore({ state: 'idle', installedVersion: this.#installedVersion });
  }

  get snapshot() {
    return this.#store.snapshot;
  }

  subscribe(listener: (snapshot: DesktopUpdateSnapshot) => void) {
    return this.#store.subscribe(listener);
  }

  /**
   * Looks immediately, and never downloads on its own.
   *
   * Both halves answer the same complaint: an update the user was never told
   * about. The check runs at launch rather than on a timer, so the rail has the
   * answer by the time they have finished looking at the window; and
   * `autoDownload` is off, so finding an update produces news to act on instead
   * of a silent ~150MB fetch whose only visible trace is the state after it.
   */
  start(): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.#started || this.#stopped) return;
      this.#started = true;
      this.#updater.allowPrerelease = false;
      this.#updater.autoDownload = false;
      this.#updater.autoInstallOnAppQuit = false;
      this.#updater.autoRunAppAfterInstall = true;
      for (const [event, listener] of this.#eventListeners) this.#updater.on(event, listener);
      // Announced but not manual: the user sees that Isagi looked, and does not
      // see a failure they did not ask for.
      this.#beginCheck({ announce: true, manual: false });
      this.#repeatCheckTimer = this.#timers.setInterval(
        () => this.#runScheduledCheck(),
        updaterSchedule.repeatCheckMs,
      );
    });
  }

  stop(): Effect.Effect<void> {
    return Effect.promise(async () => {
      if (this.#stopped) return;
      this.#stopped = true;
      this.#generation += 1;
      this.#active = undefined;
      this.#readinessGeneration = undefined;
      this.#clearTimer('repeat');
      this.#clearTimer('transient');
      if (this.#started) {
        for (const [event, listener] of this.#eventListeners) this.#updater.off(event, listener);
      }
      this.#store.clearListeners();
      await this.#diagnostics.flush();
    });
  }

  checkForUpdates(): Effect.Effect<void> {
    return Effect.sync(() => this.#beginCheck({ announce: true, manual: true }));
  }

  /**
   * Fetches the update the last check found. Only the user starts this, which is
   * why it is an intent of its own rather than something `update_available`
   * drifts into on a timer.
   *
   * A failed download is a legal starting point as well as `update_available`:
   * the provider still knows what it found, so the retry is another download
   * rather than a second round trip through the check.
   */
  downloadUpdate(): Effect.Effect<void> {
    return Effect.sync(() => this.#beginDownload());
  }

  requestRestart(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (
        this.#stopped ||
        this.#store.snapshot.state !== 'ready' ||
        this.#readinessGeneration !== undefined ||
        this.#isExitCommitted()
      )
        return;
      const generation = this.#generation;
      this.#readinessGeneration = generation;
      // The marker is single-flight state, not a result. Clearing it in a
      // finalizer keeps a defect or an interrupted read from latching restart
      // off for the rest of the session.
      const readiness = yield* this.#readRestartReadiness().pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.#readinessGeneration === generation) this.#readinessGeneration = undefined;
          }),
        ),
      );
      if (
        !this.#ownsGeneration(generation) ||
        this.#store.snapshot.state !== 'ready' ||
        this.#isExitCommitted()
      )
        return;
      if (readiness.kind === 'clear') {
        this.#beginInstallation();
        return;
      }
      const targetVersion = this.#store.snapshot.targetVersion;
      this.#store.publish({
        state: 'restart_confirmation',
        installedVersion: this.#installedVersion,
        targetVersion,
        activity:
          readiness.kind === 'working_agents'
            ? { kind: 'working', workingAgentCount: readiness.workingAgentCount }
            : { kind: 'unknown' },
      });
    });
  }

  confirmRestart(): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.#store.snapshot.state !== 'restart_confirmation') return;
      this.#beginInstallation();
    });
  }

  cancelRestart(): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.#store.snapshot.state !== 'restart_confirmation' || this.#isExitCommitted()) return;
      this.#store.publish({
        state: 'ready',
        installedVersion: this.#installedVersion,
        targetVersion: this.#store.snapshot.targetVersion,
      });
    });
  }

  quitAndInstall(): void {
    this.#updater.quitAndInstall();
  }

  recordInstallRejection(): Promise<void> {
    return this.#writeLifecycle(
      'exit_rejection',
      'The update installer rejected after desktop shutdown.',
    );
  }

  /**
   * A composition that runs the real updater never publishes
   * `manual_update_required`, so there is no snapshot here for an outcome to land
   * on and nothing for attempts to race over. The diagnostic is still written: an
   * intent that reached a self-updating build at all is worth a line in the trail.
   */
  beginDownloadPageAttempt(): ReportDownloadPageOutcome {
    return (outcome) =>
      outcome === 'opened'
        ? Promise.resolve()
        : this.#writeLifecycle(DOWNLOAD_PAGE_FAILURE.code, DOWNLOAD_PAGE_FAILURE.summary);
  }

  /**
   * The check is over the moment an update is found. Nothing is in flight after
   * this, because nothing else happens until the user presses — so the active
   * operation is cleared rather than rolled into a download phase.
   */
  readonly #onUpdateAvailable: UpdaterListener = (value) => {
    const active = this.#active;
    if (!active || active.phase !== 'check' || !this.#ownsGeneration(active.generation)) return;
    this.#active = undefined;
    this.#store.publish({
      state: 'update_available',
      installedVersion: this.#installedVersion,
      targetVersion: updateVersion(value),
    });
  };

  readonly #onUpdateNotAvailable: UpdaterListener = () => {
    const active = this.#active;
    if (!active || !this.#ownsGeneration(active.generation)) return;
    this.#active = undefined;
    if (active.manual) {
      this.#store.publish({ state: 'up_to_date', installedVersion: this.#installedVersion });
      this.#transientTimer = this.#timers.setTimeout(() => {
        this.#transientTimer = undefined;
        if (!this.#active && this.#store.snapshot.state === 'up_to_date') {
          this.#store.publish({ state: 'idle', installedVersion: this.#installedVersion });
        }
      }, updaterSchedule.upToDateMs);
    } else {
      this.#store.publish({ state: 'idle', installedVersion: this.#installedVersion });
    }
  };

  readonly #onDownloadProgress: UpdaterListener = (value) => {
    if (!this.#active || this.#active.phase !== 'download' || !this.#ownsActiveGeneration()) return;
    const targetVersion = this.#targetVersion();
    this.#store.publish({
      state: 'downloading',
      installedVersion: this.#installedVersion,
      targetVersion,
      progressPercent: normalizedProgress(value),
    });
  };

  readonly #onUpdateDownloaded: UpdaterListener = (value) => {
    if (!this.#active || this.#active.phase !== 'download' || !this.#ownsActiveGeneration()) return;
    const targetVersion = updateVersion(value) || this.#targetVersion();
    this.#active = undefined;
    this.#store.publish({
      state: 'ready',
      installedVersion: this.#installedVersion,
      targetVersion,
    });
  };

  readonly #onUpdateCancelled: UpdaterListener = () =>
    this.#handleFailure('download', 'update_cancelled');
  readonly #onError: UpdaterListener = (error) => {
    if (!this.#active || !this.#ownsActiveGeneration()) {
      void this.#writeDiagnostic('lifecycle', 'idle_error', error);
      return;
    }
    this.#handleFailure(this.#active.phase, 'updater_error', error);
  };

  get #eventListeners(): readonly (readonly [UpdaterEvent, UpdaterListener])[] {
    return [
      ['error', this.#onError],
      ['update-available', this.#onUpdateAvailable],
      ['update-not-available', this.#onUpdateNotAvailable],
      ['download-progress', this.#onDownloadProgress],
      ['update-downloaded', this.#onUpdateDownloaded],
      ['update-cancelled', this.#onUpdateCancelled],
    ];
  }

  #runScheduledCheck() {
    if (suppressesScheduledCheck(this.#store.snapshot)) return;
    this.#beginCheck({ announce: false, manual: false });
  }

  /**
   * The lock here is only the restart one, deliberately narrower than the
   * scheduled path's: a check the user pressed is allowed to run from a state a
   * timer may not disturb, because they asked and a timer did not.
   */
  #beginCheck(options: { readonly announce: boolean; readonly manual: boolean }) {
    if (!this.#started || this.#stopped || this.#active || isRestartLocked(this.#store.snapshot))
      return;
    this.#clearTimer('transient');
    const generation = this.#generation;
    this.#active = { generation, phase: 'check', ...options };
    if (options.announce)
      this.#store.publish({ state: 'checking', installedVersion: this.#installedVersion });
    void this.#updater.checkForUpdates().catch((error: unknown) => {
      if (!this.#active || this.#active.phase !== 'check' || !this.#ownsGeneration(generation))
        return;
      this.#handleFailure('check', 'check_rejected', error);
    });
  }

  #beginDownload() {
    if (!this.#started || this.#stopped || this.#active) return;
    const targetVersion = downloadableVersion(this.#store.snapshot);
    if (targetVersion === undefined) return;
    this.#clearTimer('transient');
    const generation = this.#generation;
    this.#active = { generation, phase: 'download', announce: true, manual: true };
    this.#store.publish({
      state: 'downloading',
      installedVersion: this.#installedVersion,
      targetVersion,
      progressPercent: 0,
    });
    void this.#updater.downloadUpdate().catch((error: unknown) => {
      if (!this.#active || this.#active.phase !== 'download' || !this.#ownsGeneration(generation))
        return;
      this.#handleFailure('download', 'download_rejected', error);
    });
  }

  #handleFailure(operation: 'check' | 'download', code: string, error?: unknown) {
    const active = this.#active;
    if (!active || !this.#ownsGeneration(active.generation)) return;
    this.#active = undefined;
    // Read before the transition: the failure snapshot replaces the downloading
    // one, and the target version is only still available on the outgoing state.
    const targetVersion = this.#targetVersion();
    void this.#writeDiagnostic(operation, code, error);
    if (operation === 'check' && !active.manual) {
      // A check the user did not ask for never spends the rail on its failure.
      // One that announced itself still has to take its own token back down —
      // otherwise the launch check leaves `checking…` on screen forever — but a
      // silent poll leaves the rail exactly as it found it, including an older
      // failure the user has not dealt with yet.
      if (active.announce && this.#store.snapshot.state === 'checking')
        this.#store.publish({ state: 'idle', installedVersion: this.#installedVersion });
      return;
    }
    this.#store.publish(
      operation === 'check'
        ? {
            state: 'failed',
            installedVersion: this.#installedVersion,
            operation: 'check',
            code: 'check_failed',
          }
        : {
            state: 'failed',
            installedVersion: this.#installedVersion,
            operation: 'download',
            code: 'download_failed',
            targetVersion,
          },
    );
  }

  #writeDiagnostic(operation: 'check' | 'download' | 'lifecycle', code: string, error: unknown) {
    return this.#write(operation, code, errorMessage(error));
  }

  #writeLifecycle(code: string, summary: string) {
    return this.#write('lifecycle', code, summary);
  }

  #write(operation: 'check' | 'download' | 'lifecycle', code: string, summary: string) {
    return this.#diagnostics.write({
      operation,
      platform: this.#platform,
      installedVersion: this.#installedVersion,
      ...(this.#targetVersion() ? { targetVersion: this.#targetVersion() } : {}),
      code,
      summary,
    });
  }

  #targetVersion() {
    return 'targetVersion' in this.#store.snapshot
      ? (this.#store.snapshot.targetVersion ?? '')
      : '';
  }

  #beginInstallation() {
    if (
      this.#stopped ||
      (this.#store.snapshot.state !== 'ready' &&
        this.#store.snapshot.state !== 'restart_confirmation') ||
      this.#isExitCommitted()
    )
      return;
    const targetVersion = this.#store.snapshot.targetVersion;
    this.#store.publish({
      state: 'installing',
      installedVersion: this.#installedVersion,
      targetVersion,
    });
    this.#requestInstall();
  }

  #ownsActiveGeneration() {
    return this.#active ? this.#ownsGeneration(this.#active.generation) : false;
  }

  #ownsGeneration(generation: number) {
    return !this.#stopped && generation === this.#generation;
  }

  #clearTimer(kind: 'repeat' | 'transient') {
    if (kind === 'repeat' && this.#repeatCheckTimer !== undefined) {
      this.#timers.clearInterval(this.#repeatCheckTimer);
      this.#repeatCheckTimer = undefined;
    } else if (kind === 'transient' && this.#transientTimer !== undefined) {
      this.#timers.clearTimeout(this.#transientTimer);
      this.#transientTimer = undefined;
    }
  }
}

/**
 * The compositions that never load Electron Updater. The descriptor is a union
 * rather than a state string plus optional dependencies because the two states
 * differ in what they can be asked to do: `manual_update_required` is the only
 * composition where opening the download page is reachable, so it must be able
 * to persist that failure, and requiring the sink here makes a silent no-op
 * regression impossible rather than merely discouraged.
 */
export type StaticUpdaterDescriptor =
  | { readonly state: 'disabled' }
  | {
      readonly state: 'manual_update_required';
      readonly diagnostics: UpdaterDiagnosticSink;
      readonly platform: string;
    };

export function createStaticUpdaterService(
  installedVersion: string,
  descriptor: StaticUpdaterDescriptor,
): DesktopUpdaterService {
  if (descriptor.state === 'disabled') {
    return {
      ...inertUpdaterService,
      snapshot: {
        protocolVersion: DESKTOP_UPDATE_PROTOCOL_VERSION,
        revision: 0,
        installedVersion,
        state: 'disabled',
      },
    };
  }
  return new ManualUpdateService(installedVersion, descriptor.diagnostics, descriptor.platform);
}

/**
 * Everything a build with no updater can be asked to do, which is nothing. The
 * snapshot is supplied by the caller because that is the only fact these
 * compositions differ on.
 */
const inertUpdaterService: Omit<DesktopUpdaterService, 'snapshot'> = {
  subscribe: () => () => undefined,
  start: () => Effect.void,
  stop: () => Effect.void,
  checkForUpdates: () => Effect.void,
  downloadUpdate: () => Effect.void,
  requestRestart: () => Effect.void,
  confirmRestart: () => Effect.void,
  cancelRestart: () => Effect.void,
  quitAndInstall: () => undefined,
  recordInstallRejection: () => Promise.resolve(),
  beginDownloadPageAttempt: () => () => Promise.resolve(),
};

const DOWNLOAD_PAGE_FAILURE = {
  code: 'download_page_rejected',
  summary: 'The release download page could not be opened.',
} as const;

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
class ManualUpdateService implements DesktopUpdaterService {
  readonly #store: SnapshotStore;
  /** The most recently claimed attempt. Only it may speak for the snapshot. */
  #attempts = 0;

  constructor(
    private readonly installedVersion: string,
    private readonly diagnostics: UpdaterDiagnosticSink,
    private readonly platform: string,
  ) {
    this.#store = new SnapshotStore({
      installedVersion,
      state: 'manual_update_required',
      reason: 'unsupported_installation',
      openFailure: null,
    });
  }

  get snapshot() {
    return this.#store.snapshot;
  }

  subscribe(listener: (snapshot: DesktopUpdateSnapshot) => void) {
    return this.#store.subscribe(listener);
  }

  start = () => Effect.void;
  checkForUpdates = () => Effect.void;
  downloadUpdate = () => Effect.void;
  requestRestart = () => Effect.void;
  confirmRestart = () => Effect.void;
  cancelRestart = () => Effect.void;
  quitAndInstall = () => undefined;
  recordInstallRejection = () => Promise.resolve();

  stop(): Effect.Effect<void> {
    return Effect.promise(async () => {
      this.#store.clearListeners();
      await this.diagnostics.flush();
    });
  }

  beginDownloadPageAttempt(): ReportDownloadPageOutcome {
    this.#attempts += 1;
    const attempt = this.#attempts;
    return (outcome) => this.#report(attempt, outcome);
  }

  async #report(attempt: number, outcome: DownloadPageOutcome): Promise<void> {
    // Latest press wins. A launch the user has already superseded may not speak
    // for the rail, whichever way it went — but it is still a real thing that
    // happened, so a superseded failure keeps its line in the diagnostic trail.
    if (attempt === this.#attempts) {
      // Published before the diagnostic is awaited: the user is waiting on the
      // rail, and a slow or broken log must not delay or suppress the answer.
      this.#store.publish({
        installedVersion: this.installedVersion,
        state: 'manual_update_required',
        reason: 'unsupported_installation',
        openFailure: outcome === 'failed' ? 'download_page_open_failed' : null,
      });
    }
    if (outcome === 'opened') return;
    await this.diagnostics.write({
      operation: 'lifecycle',
      platform: this.platform,
      installedVersion: this.installedVersion,
      code: DOWNLOAD_PAGE_FAILURE.code,
      summary: DOWNLOAD_PAGE_FAILURE.summary,
    });
  }
}

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

export const systemUpdaterTimers: UpdaterTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

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

function sameFacts(left: DesktopUpdateSnapshot, right: DesktopUpdateSnapshot) {
  const { revision: _leftRevision, ...leftFacts } = left;
  const { revision: _rightRevision, ...rightFacts } = right;
  return JSON.stringify(leftFacts) === JSON.stringify(rightFacts);
}
