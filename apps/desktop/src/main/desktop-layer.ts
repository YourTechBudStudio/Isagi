// The desktop main process's services as one layer. `index.ts` runs it in the process's only `ManagedRuntime`:
// building it (after `whenReady`) starts the updater and the renderer bridge, and disposing it is the whole of
// shutdown's service teardown. Finalizers run in reverse build order, so the updater stops before the runtime process
// it reads from, and the runtime process stops last.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Context, Effect, Layer, type Redacted, Stream, SubscriptionRef } from 'effect';
import type { HttpClient } from 'effect/http';

import type { HostRuntimeStatusSnapshot } from '@isagi/contracts';
import { RuntimeHttpClient } from '@isagi/runtime-client';

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

export const RUNTIME_STATUS_CHANNEL = 'isagi:runtime-status-changed';
export const DESKTOP_UPDATE_CHANNEL = 'isagi:desktop-update-changed';

/** What the desktop services need from Electron's `app` and the main window. `index.ts` implements it. */
export class DesktopShell extends Context.Service<
  DesktopShell,
  {
    /** Pushes to the renderer. Dropped once exit is requested or while there is no live window. */
    readonly send: (channel: string, payload: unknown) => void;
    /** Starts main's coordinated shutdown with this exit code. Returns at once; shutdown disposes these services. */
    readonly requestExit: (code: number) => void;
    readonly isPackaged: boolean;
    /** Electron's logs directory; read only when something is written there. */
    readonly logsDirectory: () => string;
    /**
     * Makes every window request to the managed runtime's host carry its launcher token. Called once, before the
     * renderer is told the runtime is ready; a second call is ignored.
     */
    readonly authorizeRuntimeRequests: (runtime: {
      readonly url: string;
      readonly launcherToken: Redacted.Redacted<string>;
    }) => void;
  }
>()('isagi/desktop/DesktopShell') {}

type FailedRuntimeSnapshot = Extract<HostRuntimeStatusSnapshot, { readonly state: 'failed' }>;

/**
 * Keeps the renderer told: every runtime status and update snapshot is pushed as it is published. Each stream starts
 * with the current snapshot (a `SubscriptionRef` replays its latest value), which is what the renderer's
 * subscribe-then-reconcile expects. A failed managed runtime is not pushed: it ends the app instead.
 *
 * The first managed `ready` installs the window's runtime authorization before it is forwarded. The renderer's
 * queries wait for that `ready`, so no window request reaches the runtime without the launcher token. An external
 * runtime is never authorized: the desktop holds no credential for it.
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
        if (snapshot.state === 'failed') return exitAfterRuntimeFailure(shell, snapshot);
        const forward = Effect.sync(() => shell.send(RUNTIME_STATUS_CHANNEL, snapshot));
        return snapshot.state === 'ready' && snapshot.ownership === 'managed'
          ? Effect.andThen(authorizeOnce, forward)
          : forward;
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

const exitAfterRuntimeFailure = Effect.fnUntraced(function* (
  shell: DesktopShell['Service'],
  snapshot: FailedRuntimeSnapshot,
) {
  yield* Effect.logError('Managed runtime failed', {
    reason: snapshot.reason,
    diagnostic: snapshot.diagnostic,
  });
  if (shell.isPackaged) yield* preserveRuntimeFailure(shell.logsDirectory, snapshot);
  shell.requestExit(1);
});

/**
 * A packaged build has no terminal a user could read the failure from, so the snapshot is kept as
 * `managed-runtime-failure.json` in the logs directory. Never fails: a record that cannot be written is logged, and so
 * is a logs directory Electron cannot name (`app.getPath` throws), so the exit that follows always happens.
 */
const preserveRuntimeFailure = (logsDirectory: () => string, snapshot: FailedRuntimeSnapshot) =>
  Effect.try(logsDirectory).pipe(
    Effect.matchEffect({
      onSuccess: (logDirectory) => writeRuntimeFailure(logDirectory, snapshot),
      onFailure: (error) =>
        Effect.logError(
          'Failed to preserve managed runtime failure record: no logs directory',
          error.cause,
        ),
    }),
  );

const writeRuntimeFailure = (logDirectory: string, snapshot: FailedRuntimeSnapshot) => {
  const logPath = join(logDirectory, 'managed-runtime-failure.json');
  return Effect.tryPromise(async () => {
    await mkdir(logDirectory, { recursive: true });
    await writeFile(
      logPath,
      `${JSON.stringify({ recordedAt: new Date().toISOString(), ...snapshot }, null, 2)}\n`,
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
