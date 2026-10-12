// The desktop main process's services as one layer. `index.ts` runs it in the process's only `ManagedRuntime`:
// building it (after `whenReady`) starts the updater and the renderer bridge, and disposing it is the whole of
// shutdown's service teardown. Finalizers run in reverse build order, so the updater stops before the runtime process
// it reads from, and the runtime process stops last.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Context, Effect, Layer, Stream, SubscriptionRef } from 'effect';
import type { HttpClient } from 'effect/http';

import type { HostRuntimeStatusSnapshot } from '@isagi/contracts';
import { RuntimeHttpClient } from '@isagi/runtime-client';

import { DesktopLogger } from './desktop-logger.js';
import {
  type RuntimeLifecycleFailure,
  RuntimeProcess,
  type RuntimeProcessConfig,
} from './runtime-process/index.js';
import { DesktopUpdater, type DesktopUpdaterConfig, UpdaterDiagnostics } from './updater/index.js';

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
  }
>()('isagi/desktop/DesktopShell') {}

type FailedRuntimeSnapshot = Extract<HostRuntimeStatusSnapshot, { readonly state: 'failed' }>;

/**
 * Keeps the renderer told: every runtime status and update snapshot is pushed as it is published. Each stream starts
 * with the current snapshot (a `SubscriptionRef` replays its latest value), which is what the renderer's
 * subscribe-then-reconcile expects. A failed managed runtime is not pushed: it ends the app instead.
 */
export const RendererBridgeStartup = Layer.effectDiscard(
  Effect.gen(function* () {
    const shell = yield* DesktopShell;
    const runtimeProcess = yield* RuntimeProcess;
    const updater = yield* DesktopUpdater;

    yield* SubscriptionRef.changes(runtimeProcess.status).pipe(
      Stream.runForEach((snapshot) =>
        snapshot.state === 'failed'
          ? exitAfterRuntimeFailure(shell, snapshot)
          : Effect.sync(() => shell.send(RUNTIME_STATUS_CHANNEL, snapshot)),
      ),
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

/** The runtime URL as the updater's restart-readiness read asks for it. */
const runtimeUrl: Effect.Effect<string, RuntimeLifecycleFailure, RuntimeProcess> =
  RuntimeProcess.use((runtimeProcess) => runtimeProcess.url);

export interface DesktopServicesOptions {
  /** How the runtime process is configured (`RuntimeProcessConfigElectron` in the app). */
  readonly runtimeProcessConfig: Layer.Layer<RuntimeProcessConfig, never, HttpClient.HttpClient>;
  /** How the updater is configured (`DesktopUpdaterConfig.layerElectron` in the app), given the runtime URL. */
  readonly updaterConfig: (
    runtimeUrl: Effect.Effect<string, RuntimeLifecycleFailure, RuntimeProcess>,
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
    Layer.provide(options.updaterConfig(runtimeUrl)),
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
