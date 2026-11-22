// The desktop main process's services as one layer. `index.ts` runs it in the process's only `ManagedRuntime`:
// building it (after `whenReady`) starts the updater and the window bridge, and disposing it is the whole of
// shutdown's service teardown. Finalizers run in reverse build order, so the updater stops before the runtime process
// it reads from, and the runtime process stops last.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Context, Effect, Layer, type Redacted, Stream, SubscriptionRef } from 'effect';
import type { HttpClient } from 'effect/http';

import type { HostRuntimeStatusSnapshot } from '@isagi/shared/contracts';
import { RuntimeHttpClient } from '@isagi/shared/runtime-client';

import { DesktopLogger } from './desktop-logger.js';
import {
  type RuntimeLifecycleFailure,
  RuntimeProcess,
  type RuntimeProcessConfig,
} from './runtime-process/index.js';
import {
  DesktopUpdater,
  type DesktopUpdaterConfig,
  type RuntimeAccess,
  UpdaterDiagnostics,
} from './updater/index.js';

export const DESKTOP_UPDATE_CHANNEL = 'isagi:desktop-update-changed';

/** What the desktop services need from Electron's `app` and the main window. `index.ts` implements it. */
export class DesktopShell extends Context.Service<
  DesktopShell,
  {
    /** Pushes to the renderer. Dropped once exit is requested or while there is no live window. */
    readonly send: (channel: string, payload: unknown) => void;
    /**
     * Shows what the window should for this runtime status: the loader while starting, the UI once ready, the failure
     * page once failed. Called for every snapshot, in order, starting with the current one.
     */
    readonly showRuntimeStatus: (snapshot: HostRuntimeStatusSnapshot) => void;
    /** Electron's logs directory; read only when something is written there. */
    readonly logsDirectory: () => string;
    /**
     * Makes every window request to the managed runtime's host carry its launcher token. Called once, before the
     * window is shown the ready runtime; a second call is ignored.
     */
    readonly authorizeRuntimeRequests: (runtime: {
      readonly url: string;
      readonly launcherToken: Redacted.Redacted<string>;
    }) => void;
  }
>()('isagi/desktop/DesktopShell') {}

type FailedRuntimeSnapshot = Extract<HostRuntimeStatusSnapshot, { readonly state: 'failed' }>;

/**
 * Keeps the window current: every runtime status is shown as it is published, and every update snapshot is pushed to
 * the renderer. Each stream starts with the current snapshot (a `SubscriptionRef` replays its latest value), which is
 * what the renderer's subscribe-then-reconcile expects for updates. A failed runtime is shown as the failure page; the
 * app keeps running until the user quits.
 *
 * The first `ready` installs the window's runtime authorization before it is shown. The window loads the UI only on
 * `ready`, so no window request reaches the runtime without the launcher token.
 */
export const RendererBridgeStartup = Layer.effectDiscard(
  Effect.gen(function* () {
    const shell = yield* DesktopShell;
    const runtimeProcess = yield* RuntimeProcess;
    const updater = yield* DesktopUpdater;

    let authorized = false;
    const authorizeOnce = Effect.gen(function* () {
      if (authorized) return;
      authorized = true;
      // Ready, so this is the URL the runtime announced, at once.
      const url = yield* runtimeProcess.url;
      shell.authorizeRuntimeRequests({ url, launcherToken: runtimeProcess.launcherToken });
    }).pipe(
      Effect.catch((failure) =>
        Effect.logError('Could not authorize window requests to the managed runtime', {
          reason: failure.reason,
        }),
      ),
    );

    yield* SubscriptionRef.changes(runtimeProcess.status).pipe(
      Stream.runForEach((snapshot) => {
        const show = Effect.sync(() => shell.showRuntimeStatus(snapshot));
        if (snapshot.state === 'failed') {
          return Effect.andThen(
            recordRuntimeFailure(shell, snapshot, runtimeProcess.recentOutput),
            show,
          );
        }
        return snapshot.state === 'ready' ? Effect.andThen(authorizeOnce, show) : show;
      }),
      Effect.forkScoped,
    );
    yield* SubscriptionRef.changes(updater.status).pipe(
      Stream.runForEach((snapshot) =>
        Effect.sync(() => shell.send(DESKTOP_UPDATE_CHANNEL, snapshot)),
      ),
      Effect.forkScoped,
    );
  }),
);

const recordRuntimeFailure = Effect.fnUntraced(function* (
  shell: DesktopShell['Service'],
  snapshot: FailedRuntimeSnapshot,
  recentOutput: Effect.Effect<string>,
) {
  yield* Effect.logError('Managed runtime failed', {
    reason: snapshot.reason,
    diagnostic: snapshot.diagnostic,
  });
  yield* preserveRuntimeFailure(shell.logsDirectory, snapshot, yield* recentOutput);
});

/**
 * The failure page's Open logs opens the logs directory, and a packaged build has no terminal its runtime's output
 * reaches, so the snapshot and the runtime's last output (bounded, as `RuntimeProcess.recentOutput` keeps it) are kept
 * as `managed-runtime-failure.json` there: the reason a runtime would not start (a malformed `config.yaml`, a port in
 * use) is in that output. Written in every mode; an unpackaged run's logs directory sits beside its data directory.
 * Never fails: a record that cannot be written is logged, and so is a logs directory Electron cannot name
 * (`app.getPath` throws), so the failure page that follows always shows.
 */
const preserveRuntimeFailure = (
  logsDirectory: () => string,
  snapshot: FailedRuntimeSnapshot,
  lastOutput: string,
) =>
  Effect.try(logsDirectory).pipe(
    Effect.matchEffect({
      onSuccess: (logDirectory) => writeRuntimeFailure(logDirectory, snapshot, lastOutput),
      onFailure: (error) =>
        Effect.logError(
          'Failed to preserve managed runtime failure record: no logs directory',
          error.cause,
        ),
    }),
  );

const writeRuntimeFailure = (
  logDirectory: string,
  snapshot: FailedRuntimeSnapshot,
  lastOutput: string,
) => {
  const logPath = join(logDirectory, 'managed-runtime-failure.json');
  return Effect.tryPromise(async () => {
    await mkdir(logDirectory, { recursive: true });
    await writeFile(
      logPath,
      `${JSON.stringify({ recordedAt: new Date().toISOString(), ...snapshot, lastOutput }, null, 2)}\n`,
      'utf8',
    );
  }).pipe(
    Effect.matchEffect({
      onSuccess: () => Effect.logError(`Managed runtime failure record written to ${logPath}`),
      onFailure: (error) =>
        Effect.logError(
          `Failed to preserve managed runtime failure record at ${logPath}`,
          error.cause,
        ),
    }),
  );
};

/** The runtime URL and launcher token, as the updater's restart-readiness read asks for them. */
const runtimeAccess: Effect.Effect<RuntimeAccess, RuntimeLifecycleFailure, RuntimeProcess> =
  RuntimeProcess.use((runtimeProcess) =>
    Effect.map(runtimeProcess.url, (url) => ({
      url,
      launcherToken: runtimeProcess.launcherToken,
    })),
  );

export interface DesktopServicesOptions {
  /** How the runtime process is configured (`RuntimeProcessConfigElectron` in the app). */
  readonly runtimeProcessConfig: Layer.Layer<RuntimeProcessConfig, never, HttpClient.HttpClient>;
  /** How the updater is configured (`DesktopUpdaterConfig.layerElectron` in the app), given runtime access. */
  readonly updaterConfig: (
    runtimeAccess: Effect.Effect<RuntimeAccess, RuntimeLifecycleFailure, RuntimeProcess>,
  ) => Layer.Layer<DesktopUpdaterConfig, never, RuntimeProcess>;
}

/**
 * The runtime process, the updater and the renderer bridge, wired to each other. Leaves the platform open: the shell,
 * the HTTP client and the logger.
 *
 * Build order is runtime process, updater, bridge; so release order is bridge, updater, runtime process.
 */
export const makeDesktopServices = (
  options: DesktopServicesOptions,
): Layer.Layer<RuntimeProcess | DesktopUpdater, never, DesktopShell | HttpClient.HttpClient> =>
  RendererBridgeStartup.pipe(
    Layer.provideMerge(DesktopUpdater.layer),
    Layer.provide(UpdaterDiagnostics.layer),
    Layer.provide(options.updaterConfig(runtimeAccess)),
    Layer.provideMerge(RuntimeProcess.layer),
    Layer.provide(options.runtimeProcessConfig),
  );

/**
 * Everything main runs effects against. The shell, the HTTP client and the logger are merged into the output (not only
 * provided), so effects main runs itself (IPC handlers, the dev web-server wait) get the same client and log lines.
 */
export const makeDesktopLayer = (
  options: DesktopServicesOptions & { readonly shell: DesktopShell['Service'] },
): Layer.Layer<
  RuntimeProcess | DesktopUpdater | DesktopShell | HttpClient.HttpClient,
  never,
  never
> =>
  makeDesktopServices(options).pipe(
    Layer.provideMerge(
      Layer.mergeAll(Layer.succeed(DesktopShell, options.shell), RuntimeHttpClient, DesktopLogger),
    ),
  );
