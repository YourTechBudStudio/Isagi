import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Cause, Effect, Exit, ManagedRuntime, SubscriptionRef } from 'effect';
import { app, BrowserWindow, ipcMain, shell } from 'electron';

import { developmentEnvironmentKeys } from '../../../../scripts/dev-supervisor/dev-protocol.mjs';
import { waitForWebServer } from './boot.js';
import { DesktopShell, makeDesktopLayer } from './desktop-layer.js';
import { DesktopLogger } from './desktop-logger.js';
import { configureDevelopmentUserData } from './development.js';
import { assertAuthorizedIpcSender } from './ipc-security.js';
import {
  isAllowedRendererNavigation,
  navigationDenialCoordinate,
  rendererContentSecurityPolicy,
  rendererDocumentUrl,
  rendererHeadersReceivedDecision,
  rendererRuntimeOrigins,
  type RendererTarget,
} from './renderer-policy.js';
import { destroyRendererForExit, resolveRuntimeUrlForIpc } from './runtime-ipc.js';
import { RuntimeProcess } from './runtime-process/index.js';
import { RuntimeProcessConfigElectron } from './runtime.js';
import { DesktopShutdownCoordinator, handleBeforeQuit, startDesktop } from './shutdown.js';
import {
  decodeDesktopUpdateIntent,
  DesktopUpdater,
  DesktopUpdaterConfig,
  dispatchDesktopUpdateIntent,
} from './updater/index.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const APP_ID = 'studio.yourtechbud.isagi';
const DEVELOPMENT_ICON_PATH = join(
  currentDirectory,
  `../../assets/${process.platform === 'darwin' ? 'app-icon.png' : 'app-icon-linux.png'}`,
);
const TRAFFIC_LIGHT_POSITION = { x: 18, y: 18 };
const HIDDEN_TRAFFIC_LIGHT_POSITION = { x: -100, y: -100 };
const isMac = process.platform === 'darwin';
const isDev = !app.isPackaged;
const desktopRoot = join(currentDirectory, '../..');
const repositoryRoot = join(desktopRoot, '../..');

app.setAppUserModelId(APP_ID);
if (isDev) configureDevelopmentUserData(repositoryRoot);

let mainWindow: BrowserWindow | undefined;
let runtimeStartPromise: Promise<void> | undefined;
let exitRequested = false;
/** Captured once the desktop runtime has built; the installer path runs after that runtime is disposed. */
let updaterInstaller: DesktopUpdater['Service']['installer'] | undefined;

const shutdown = new DesktopShutdownCoordinator({
  dispose: () => desktop.dispose(),
  destroyRenderer: () => {
    // Nothing can receive a snapshot past this point (`send` drops it). That
    // includes an install's `installing` snapshot: the updater publishes it just
    // before requesting the install, but the bridge streams it asynchronously,
    // so it arrives after this flag is set and is dropped. The renderer never
    // shows it; the window is destroyed in this same tick.
    exitRequested = true;
    destroyRendererForExit(mainWindow);
  },
  exit: (code) => app.exit(code),
  // The one desktop effect not run on `desktop`: the installer is invoked only after `dispose` has stopped the updater
  // and the runtime process, so a rejection is known only once `desktop` is disposed (where every run dies with
  // "ManagedRuntime disposed"). The record is requirement-free by design and gets the desktop logger here.
  diagnoseInstallRejection: () =>
    updaterInstaller &&
    Effect.runPromise(updaterInstaller.recordInstallRejection.pipe(Effect.provide(DesktopLogger))),
});

const desktopShell = DesktopShell.of({
  send: (channel, payload) => {
    if (exitRequested) return;
    const webContents = mainWindow?.webContents;
    if (!webContents || webContents.isDestroyed()) return;
    webContents.send(channel, payload);
  },
  requestExit: (code) => void requestExit({ code }),
  isPackaged: app.isPackaged,
  logsDirectory: () => app.getPath('logs'),
});

/**
 * The process's one Effect runtime. Nothing builds until its first use, which is after `whenReady`, so Electron's
 * `app` is only read once it is ready; disposing it (shutdown) stops the updater, then the runtime process.
 */
const desktop = ManagedRuntime.make(
  makeDesktopLayer({
    shell: desktopShell,
    runtimeProcessConfig: RuntimeProcessConfigElectron,
    updaterConfig: (runtimeUrl) =>
      DesktopUpdaterConfig.layerElectron(app, {
        runtimeUrl,
        isExitCommitted: () => shutdown.committed,
        requestInstall: (install) => void shutdown.request({ kind: 'install_update', install }),
      }),
  }),
);

/**
 * Runs `effect` on the desktop runtime from an Electron callback. Rejects with what it failed with, except when shutdown
 * interrupted it by disposing the runtime under it: the quit is proceeding, so that settles with `undefined` instead of
 * surfacing as a failure (or as an error Electron logs for an IPC handler whose renderer is already gone).
 */
async function runDesktop<A, E>(
  effect: Effect.Effect<A, E, ManagedRuntime.ManagedRuntime.Services<typeof desktop>>,
): Promise<A | undefined> {
  const exit = await desktop.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  if (exitRequested && Cause.hasInterruptsOnly(exit.cause)) return undefined;
  throw Cause.squash(exit.cause);
}

function createWindow() {
  return runDesktop(createWindowEffect());
}

function createWindowEffect() {
  return Effect.gen(function* () {
    yield* Effect.logInfo(
      `creating Isagi window: mode=${isDev ? 'dev' : 'packaged'} chrome=${
        isMac ? 'mac-hiddenInset@18,18' : 'native'
      }`,
    );

    const target = resolveRendererTarget();
    if (!target)
      return yield* Effect.fail(new Error('Desktop development requires ISAGI_WEB_URL.'));

    const window = new BrowserWindow({
      backgroundColor: '#24273a',
      height: 900,
      minHeight: 600,
      minWidth: 900,
      show: false,
      title: isDev ? 'Isagi · dev' : 'Isagi',
      ...(isDev && !isMac ? { icon: DEVELOPMENT_ICON_PATH } : {}),
      ...(isMac
        ? {
            frame: false,
            titleBarStyle: 'hiddenInset' as const,
            trafficLightPosition: TRAFFIC_LIGHT_POSITION,
          }
        : {}),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        // Asserted rather than inherited. The renderer frames a Code Server
        // workbench, so a default flipping later would hand a foreign origin a
        // Node environment. `webSecurity` is deliberately not named here:
        // naming it would invite someone to think it is tunable.
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        preload: join(currentDirectory, '../preload/index.js'),
      },
      width: 1280,
    });
    mainWindow = window;
    window.once('closed', () => {
      if (mainWindow === window) mainWindow = undefined;
    });
    window.once('ready-to-show', () => window.show());

    // Containment precedes both the runtime and the renderer: the first frame
    // the workbench could ever paint must not be the first one uncontained.
    installRendererContainment(window, target);
    startRuntime();
    yield* loadRenderer(window, target);
  });
}

function resolveRendererTarget(): RendererTarget | undefined {
  if (app.isPackaged) {
    return { mode: 'packaged', indexPath: join(process.resourcesPath, 'web/index.html') };
  }
  const webUrl = process.env[developmentEnvironmentKeys.webUrl];
  return webUrl ? { mode: 'development', devWebUrl: webUrl } : undefined;
}

/**
 * Installs the renderer's containment boundary on the window that will host it.
 *
 * Electron keeps only the most recent listener for a WebRequest event, so this
 * hook is the session's single `onHeadersReceived` owner. Nothing else in the
 * desktop registers one today; anything that wants to must extend this handler
 * rather than add a second, which would silently displace the policy. The
 * filter argument is omitted deliberately — an omitted filter matches every
 * request, which is what keeps packaged `file://` traffic in scope.
 */
function installRendererContainment(window: BrowserWindow, target: RendererTarget) {
  const documentUrl = rendererDocumentUrl(target);
  const external = rendererRuntimeOrigins({ externalRuntimeUrl: process.env.ISAGI_RUNTIME_URL });
  if (external.rejected) {
    console.warn(
      '[desktop] ISAGI_RUNTIME_URL is not a credential-free HTTP(S) URL; renderer connections stay loopback-only',
    );
  }
  const policy = rendererContentSecurityPolicy({ target, runtimeOrigins: external.origins });
  const rendererWebContentsId = window.webContents.id;

  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const decision = rendererHeadersReceivedDecision(details, {
      rendererWebContentsId,
      rendererDocumentUrl: documentUrl,
      policy,
    });
    // Injected, not enforced: this proves the header was supplied. Whether
    // Chromium enforced it is established by inspecting the loaded document.
    if (decision.kind === 'inject') {
      console.info('[desktop] renderer content security policy injected');
    }
    callback(decision.response);
  });

  window.webContents.on('will-navigate', (details) => {
    if (isAllowedRendererNavigation({ url: details.url, rendererDocumentUrl: documentUrl })) return;
    details.preventDefault();
    // Only a safe coordinate: a denied URL can carry credentials, a path, a
    // query, a fragment, or `javascript:` source.
    console.info(
      `[desktop] denied renderer navigation to ${navigationDenialCoordinate(details.url)}`,
    );
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    console.info(`[desktop] denied renderer window open for ${navigationDenialCoordinate(url)}`);
    return { action: 'deny' };
  });
}

function startRuntime() {
  runtimeStartPromise ??= desktop
    .runPromiseExit(RuntimeProcess.use((runtimeProcess) => runtimeProcess.start))
    .then((exit) => {
      // Shutdown interrupts a start still in flight; that is not a failure to report.
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
        console.error(Cause.pretty(exit.cause));
      }
    });
  return runtimeStartPromise;
}

/**
 * Loads the exact URL the containment policy was scoped to. `loadFile` would
 * do its own path-to-URL conversion, and any disagreement with `pathToFileURL`
 * would leave the renderer's document response unmatched and the policy
 * silently uninjected. Loading the compared string removes the question.
 */
function loadRenderer(window: BrowserWindow, target: RendererTarget) {
  const documentUrl = rendererDocumentUrl(target);
  if (target.mode === 'packaged') return tryPromise(() => window.loadURL(documentUrl));
  return Effect.gen(function* () {
    yield* waitForWebServer(target.devWebUrl);
    yield* tryPromise(() => window.loadURL(documentUrl));
  });
}

function tryPromise<T>(run: () => Promise<T>) {
  return Effect.tryPromise({ try: run, catch: toError });
}

ipcMain.handle('isagi:runtime-url', (event) => {
  assertAuthorizedIpcSender(mainWindow, event);
  return resolveRuntimeUrlForIpc(
    () => desktop.runPromise(RuntimeProcess.use((runtimeProcess) => runtimeProcess.url)),
    () => exitRequested,
  );
});

ipcMain.handle('isagi:runtime-status', (event) => {
  assertAuthorizedIpcSender(mainWindow, event);
  return runDesktop(
    RuntimeProcess.use((runtimeProcess) => SubscriptionRef.get(runtimeProcess.status)),
  );
});

ipcMain.handle('isagi:desktop-update', (event) => {
  assertAuthorizedIpcSender(mainWindow, event);
  return runDesktop(DesktopUpdater.use((updater) => SubscriptionRef.get(updater.status)));
});

ipcMain.handle('isagi:desktop-update-intent', async (event, payload: unknown) => {
  assertAuthorizedIpcSender(mainWindow, event);
  const intent = decodeDesktopUpdateIntent(payload);
  // Confirming a restart hands the process to the installer, whose shutdown disposes the runtime under this intent.
  await runDesktop(
    dispatchDesktopUpdateIntent(intent, { openExternal: (url) => shell.openExternal(url) }),
  );
});

ipcMain.handle('isagi:host-chrome-visible', (event, visible: unknown) => {
  assertAuthorizedIpcSender(mainWindow, event);
  console.info(`[desktop] host-chrome visible=${String(visible)} (mac=${String(isMac)})`);
  if (!isMac) return;
  const shouldShow = visible === true;
  mainWindow?.setWindowButtonVisibility(shouldShow);
  mainWindow?.setWindowButtonPosition(
    shouldShow ? TRAFFIC_LIGHT_POSITION : HIDDEN_TRAFFIC_LIGHT_POSITION,
  );
});

ipcMain.handle('isagi:quit-app', async (event) => {
  assertAuthorizedIpcSender(mainWindow, event);
  console.info('[desktop] quit requested by renderer');
  await requestExit({ code: 0 });
});

function requestExit(options: { readonly code: number }) {
  return shutdown.request({ kind: 'ordinary', code: options.code });
}

app.on('window-all-closed', () => {
  if (isDev || process.platform !== 'darwin') void requestExit({ code: 0 });
});

app.on('before-quit', (event) =>
  handleBeforeQuit(event, shutdown, () => void requestExit({ code: 0 })),
);

process.once('SIGINT', () => void requestExit({ code: 130 }));
process.once('SIGTERM', () => void requestExit({ code: 143 }));

app
  .whenReady()
  .then(async () => {
    if (isDev && app.dock) app.dock.setIcon(DEVELOPMENT_ICON_PATH);
    // A quit before the app was ready, or during the build, has already disposed the desktop runtime.
    await startDesktop({
      isExitRequested: () => exitRequested,
      // The first use builds the desktop runtime: the updater starts (its launch check
      // included) and the renderer bridge subscribes, both before the window exists. A
      // snapshot published before the renderer can listen is not lost: the renderer
      // reconciles the current snapshot when it subscribes.
      build: async () => {
        updaterInstaller = await runDesktop(DesktopUpdater.useSync((updater) => updater.installer));
      },
      openWindow: createWindow,
    });
  })
  .catch((error: unknown) => {
    console.error(error);
    void requestExit({ code: 1 });
  });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
