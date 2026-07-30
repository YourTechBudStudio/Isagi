import { Effect } from 'effect';

import { DESKTOP_UPDATE_PROTOCOL_VERSION, type DesktopUpdateSnapshot } from '@isagi/contracts';

import type { UpdaterDiagnosticSink } from './diagnostics.js';

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
  checkForUpdates(): Promise<unknown>;
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
}

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

export class UpdaterCoordinator implements DesktopUpdaterService {
  readonly #updater: UpdaterAdapter;
  readonly #timers: UpdaterTimers;
  readonly #diagnostics: UpdaterDiagnosticSink;
  readonly #platform: string;
  readonly #installedVersion: string;
  readonly #listeners = new Set<(snapshot: DesktopUpdateSnapshot) => void>();
  #snapshot: DesktopUpdateSnapshot;
  #revision = 0;
  #generation = 0;
  #started = false;
  #stopped = false;
  #active: ActiveOperation | undefined;
  #firstCheckTimer: unknown;
  #repeatCheckTimer: unknown;
  #transientTimer: unknown;

  constructor(dependencies: {
    readonly updater: UpdaterAdapter;
    readonly timers: UpdaterTimers;
    readonly diagnostics: UpdaterDiagnosticSink;
    readonly platform: string;
    readonly installedVersion: string;
  }) {
    this.#updater = dependencies.updater;
    this.#timers = dependencies.timers;
    this.#diagnostics = dependencies.diagnostics;
    this.#platform = dependencies.platform;
    this.#installedVersion = dependencies.installedVersion;
    this.#snapshot = {
      protocolVersion: DESKTOP_UPDATE_PROTOCOL_VERSION,
      revision: 0,
      state: 'idle',
      installedVersion: this.#installedVersion,
    };
  }

  get snapshot() {
    return this.#snapshot;
  }

  subscribe(listener: (snapshot: DesktopUpdateSnapshot) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.#started || this.#stopped) return;
      this.#started = true;
      this.#updater.allowPrerelease = false;
      this.#updater.autoDownload = true;
      this.#updater.autoInstallOnAppQuit = false;
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
      this.#clearTimer('first');
      this.#clearTimer('repeat');
      this.#clearTimer('transient');
      if (this.#started) {
        for (const [event, listener] of this.#eventListeners) this.#updater.off(event, listener);
      }
      this.#listeners.clear();
      await this.#diagnostics.flush();
    });
  }

  checkForUpdates(): Effect.Effect<void> {
    return Effect.sync(() => this.#beginCheck(true));
  }

  readonly #onUpdateAvailable: UpdaterListener = (value) => {
    if (!this.#ownsActiveGeneration()) return;
    const targetVersion = updateVersion(value);
    this.#active = { ...this.#active!, phase: 'download' };
    this.#transition({
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
      this.#transition({ state: 'up_to_date', installedVersion: this.#installedVersion });
      this.#transientTimer = this.#timers.setTimeout(() => {
        this.#transientTimer = undefined;
        if (!this.#active && this.#snapshot.state === 'up_to_date') {
          this.#transition({ state: 'idle', installedVersion: this.#installedVersion });
        }
      }, updaterSchedule.upToDateMs);
    } else {
      this.#transition({ state: 'idle', installedVersion: this.#installedVersion });
    }
  };

  readonly #onDownloadProgress: UpdaterListener = (value) => {
    if (!this.#active || this.#active.phase !== 'download' || !this.#ownsActiveGeneration()) return;
    const targetVersion = this.#targetVersion();
    this.#transition({
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
    this.#transition({ state: 'ready', installedVersion: this.#installedVersion, targetVersion });
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
    if (this.#snapshot.state === 'ready') return;
    this.#beginCheck(false);
  }

  #beginCheck(manual: boolean) {
    if (!this.#started || this.#stopped || this.#active || this.#snapshot.state === 'ready') return;
    this.#clearTimer('transient');
    const generation = this.#generation;
    this.#active = { generation, phase: 'check', manual };
    if (manual) this.#transition({ state: 'checking', installedVersion: this.#installedVersion });
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
    void this.#writeDiagnostic(operation, code, error);
    if (operation === 'check' && !active.manual) return;
    this.#transition(
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
          },
    );
  }

  #writeDiagnostic(operation: 'check' | 'download' | 'lifecycle', code: string, error: unknown) {
    return this.#diagnostics.write({
      operation,
      platform: this.#platform,
      installedVersion: this.#installedVersion,
      ...(this.#targetVersion() ? { targetVersion: this.#targetVersion() } : {}),
      code,
      summary: errorMessage(error),
    });
  }

  #targetVersion() {
    return 'targetVersion' in this.#snapshot ? (this.#snapshot.targetVersion ?? '') : '';
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

  #transition(facts: SnapshotFacts) {
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

export function createStaticUpdaterService(
  installedVersion: string,
  state: 'disabled' | 'manual_update_required',
): DesktopUpdaterService {
  const snapshot: DesktopUpdateSnapshot =
    state === 'disabled'
      ? { protocolVersion: DESKTOP_UPDATE_PROTOCOL_VERSION, revision: 0, installedVersion, state }
      : {
          protocolVersion: DESKTOP_UPDATE_PROTOCOL_VERSION,
          revision: 0,
          installedVersion,
          state,
          reason: 'unsupported_installation',
        };
  return {
    snapshot,
    subscribe: () => () => undefined,
    start: () => Effect.void,
    stop: () => Effect.void,
    checkForUpdates: () => Effect.void,
  };
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
