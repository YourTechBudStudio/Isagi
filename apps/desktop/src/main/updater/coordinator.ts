import { Effect } from 'effect';

import { DESKTOP_UPDATE_PROTOCOL_VERSION, type DesktopUpdateSnapshot } from '@isagi/contracts';

import type { UpdaterDiagnosticSink } from './diagnostics.js';
import type { DownloadPageOutcome } from './download-page.js';

export const updaterSchedule = {
  firstCheckMs: 30_000,
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
type ActiveOperation = {
  readonly generation: number;
  phase: 'check' | 'download';
  manual: boolean;
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
  #firstCheckTimer: unknown;
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

  start(): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.#started || this.#stopped) return;
      this.#started = true;
      this.#updater.allowPrerelease = false;
      this.#updater.autoDownload = true;
      this.#updater.autoInstallOnAppQuit = false;
      this.#updater.autoRunAppAfterInstall = true;
      for (const [event, listener] of this.#eventListeners) this.#updater.on(event, listener);
      this.#firstCheckTimer = this.#timers.setTimeout(() => {
        this.#firstCheckTimer = undefined;
        this.#runScheduledCheck();
        this.#repeatCheckTimer = this.#timers.setInterval(
          () => this.#runScheduledCheck(),
          updaterSchedule.repeatCheckMs,
        );
      }, updaterSchedule.firstCheckMs);
    });
  }

  stop(): Effect.Effect<void> {
    return Effect.promise(async () => {
      if (this.#stopped) return;
      this.#stopped = true;
      this.#generation += 1;
      this.#active = undefined;
      this.#readinessGeneration = undefined;
      this.#clearTimer('first');
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
    return Effect.sync(() => this.#beginCheck(true));
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

  readonly #onUpdateAvailable: UpdaterListener = (value) => {
    if (!this.#ownsActiveGeneration()) return;
    const targetVersion = updateVersion(value);
    this.#active = { ...this.#active!, phase: 'download' };
    this.#store.publish({
      state: 'downloading',
      installedVersion: this.#installedVersion,
      targetVersion,
      progressPercent: 0,
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
    if (isRestartLocked(this.#store.snapshot)) return;
    this.#beginCheck(false);
  }

  #beginCheck(manual: boolean) {
    if (!this.#started || this.#stopped || this.#active || isRestartLocked(this.#store.snapshot))
      return;
    this.#clearTimer('transient');
    const generation = this.#generation;
    this.#active = { generation, phase: 'check', manual };
    if (manual)
      this.#store.publish({ state: 'checking', installedVersion: this.#installedVersion });
    void this.#updater.checkForUpdates().catch((error: unknown) => {
      if (!this.#active || this.#active.phase !== 'check' || !this.#ownsGeneration(generation))
        return;
      this.#handleFailure('check', 'check_rejected', error);
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
    if (operation === 'check' && !active.manual) return;
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

  #clearTimer(kind: 'first' | 'repeat' | 'transient') {
    if (kind === 'first' && this.#firstCheckTimer !== undefined) {
      this.#timers.clearTimeout(this.#firstCheckTimer);
      this.#firstCheckTimer = undefined;
    } else if (kind === 'repeat' && this.#repeatCheckTimer !== undefined) {
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
