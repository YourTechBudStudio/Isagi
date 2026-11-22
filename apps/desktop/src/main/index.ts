import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Cause, Effect, Exit, ManagedRuntime, Redacted, SubscriptionRef } from 'effect';
import { app, BrowserWindow, ipcMain, session, shell } from 'electron';

import {
  HOST_RUNTIME_STATUS_PROTOCOL_VERSION,
  type AppearanceTheme,
  type HostRuntimeDiagnostic,
  type HostRuntimeStatusSnapshot,
} from '@isagi/shared/contracts';

import { developmentEnvironmentKeys } from '../../../../scripts/dev-supervisor/dev-protocol.mjs';
import { waitForWebServer } from './boot.js';
import { DesktopShell, makeDesktopLayer } from './desktop-layer.js';
import { DesktopLogger } from './desktop-logger.js';
import { resolveDesktopDataDirectory, resolveDesktopMode } from './desktop-mode.js';
import { readDesktopTheme, windowBackgroundColor } from './desktop-theme.js';
import { configureUnpackagedUserData, resolveDevelopmentRoot } from './development.js';
import { assertAuthorizedIpcSender } from './ipc-security.js';
import { runtimeRequestHeaders } from './runtime-authorization.js';
import { destroyRendererForExit } from './runtime-ipc.js';
import { RuntimeProcess } from './runtime-process/index.js';
import { runtimeProcessConfigElectron } from './runtime.js';
import { DesktopShutdownCoordinator, handleBeforeQuit, startDesktop } from './shutdown.js';
import {
  decodeDesktopUpdateIntent,
  DesktopUpdater,
  DesktopUpdaterConfig,
  dispatchDesktopUpdateIntent,
} from './updater/index.js';
import {
  isAllowedWindowNavigation,
  isLoaderDocument,
  isUiDocument,
  loaderBaseUrl,
  loaderUrl,
  navigationDenialCoordinate,
  pageLoadFailure,
  windowContent,
} from './window-content.js';

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
/** Built beside `main/` by `scripts/build-loader.mjs`, in `dist-electron/loader/`, and packaged with it. */
const loaderDirectory = join(currentDirectory, '../loader');

app.setAppUserModelId(APP_ID);

// Resolved once, before anything paints: the mode, the one data directory (also the managed runtime's `--data-dir`)
// and the theme from its `config.yaml`, so the window background and the loader are right on the first frame.
const mode = resolveDesktopMode({
  isPackaged: app.isPackaged,
  webUrl: process.env[developmentEnvironmentKeys.webUrl],
});
const dataDirectory = resolveDesktopDataDirectory({
  mode,
  env: process.env,
  developmentRoot: () => resolveDevelopmentRoot(repositoryRoot),
});
if (mode.kind !== 'packaged') configureUnpackagedUserData(dataDirectory);
const theme: AppearanceTheme = readDesktopTheme(dataDirectory);
const windowBackgrounds = JSON.parse(
  readFileSync(join(loaderDirectory, 'window-backgrounds.json'), 'utf8'),
) as Readonly<Record<AppearanceTheme, string>>;
const loaderBase = loaderBaseUrl(join(loaderDirectory, 'loader.html'));
/** In development the window loads Vite, which proxies to the runtime; otherwise the runtime's own origin. */
const developmentOrigin =
  mode.kind === 'development' && URL.canParse(mode.webUrl)
    ? new URL(mode.webUrl).origin
    : undefined;

let mainWindow: BrowserWindow | undefined;
let runtimeStartPromise: Promise<void> | undefined;
let exitRequested = false;
/** Captured once the desktop runtime has built; the installer path runs after that runtime is disposed. */
let updaterInstaller: DesktopUpdater['Service']['installer'] | undefined;

/** The latest runtime status; what the window shows follows from it (`windowContent`). */
let runtimeStatus: HostRuntimeStatusSnapshot = {
  protocolVersion: HOST_RUNTIME_STATUS_PROTOCOL_VERSION,
  revision: 0,
  state: 'connecting',
};
/** Set once the UI page failed to load in the main frame; the window then shows the failure page. */
let pageFailure: HostRuntimeDiagnostic | undefined;
/** The origin the UI is loaded from, known once the runtime is ready. */
let uiOrigin: string | undefined;
/** The URL the window was last asked to load, so an unchanged status does not reload it. */
let shownUrl: string | undefined;
/** Bumped by every render, so a render that awaited the UI URL does not overwrite a newer one. */
let renderGeneration = 0;

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
  showRuntimeStatus: (snapshot) => {
    runtimeStatus = snapshot;
    if (mainWindow) void showWindowContent(mainWindow);
  },
  logsDirectory: () => app.getPath('logs'),
  authorizeRuntimeRequests: (runtime) => installRuntimeAuthorization(runtime),
});

let runtimeAuthorizationInstalled = false;

/**
 * Makes every window request to the managed runtime carry its launcher token: fetches (Fluidcast's
 * event streams included), the sockets, the editor iframe and everything inside it, and media URLs.
 * In development the window's requests go to the Vite dev server, which proxies them to the runtime and
 * forwards the header, so its host carries the token too. The renderer, the preload bridge and the web app
 * never see the token.
 *
 * Electron keeps only the most recent listener for a WebRequest event, so this hook is the default
 * session's single `onBeforeSendHeaders` owner; anything else that wants one must extend this
 * handler rather than add a second. The window uses the default session. The filter is omitted
 * deliberately: `runtimeRequestHeaders` matches the hosts themselves, which Electron's URL patterns
 * cannot express by port.
 */
function installRuntimeAuthorization(runtime: {
  readonly url: string;
  readonly launcherToken: Redacted.Redacted<string>;
}) {
  if (runtimeAuthorizationInstalled) {
    console.warn('[desktop] runtime request authorization is already installed; ignoring');
    return;
  }
  runtimeAuthorizationInstalled = true;
  const target = {
    hosts: [
      new URL(runtime.url).host,
      ...(developmentOrigin === undefined ? [] : [new URL(developmentOrigin).host]),
    ],
    authorization: `Bearer ${Redacted.value(runtime.launcherToken)}`,
  };
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: runtimeRequestHeaders(details, target) });
  });
  console.info('[desktop] runtime request authorization installed');
}

/**
 * The process's one Effect runtime. Nothing builds until its first use, which is after `whenReady`, so Electron's
 * `app` is only read once it is ready; disposing it (shutdown) stops the updater, then the runtime process.
 */
const desktop = ManagedRuntime.make(
  makeDesktopLayer({
    shell: desktopShell,
    runtimeProcessConfig: runtimeProcessConfigElectron({ mode, dataDirectory }),
    updaterConfig: (runtimeAccess) =>
      DesktopUpdaterConfig.layerElectron(app, {
        runtimeAccess,
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
  console.info(
    `[desktop] creating Isagi window: mode=${mode.kind} theme=${theme} chrome=${
      isMac ? 'mac-hiddenInset@18,18' : 'native'
    }`,
  );

  const window = new BrowserWindow({
    backgroundColor: windowBackgroundColor(windowBackgrounds, theme),
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
      // Asserted rather than inherited. The UI frames a Code Server
      // workbench, so a default flipping later would hand that frame a
      // Node environment. `webSecurity` is deliberately not named here:
      // naming it would invite someone to think it is tunable.
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      preload: join(currentDirectory, '../preload/index.js'),
    },
    width: 1280,
  });
  mainWindow = window;
  shownUrl = undefined;
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  window.once('ready-to-show', () => window.show());

  // Containment precedes both the runtime and the first document: the first frame
  // the window could ever paint must not be the first one uncontained.
  installWindowContainment(window);
  startRuntime();
  void showWindowContent(window);
}

/**
 * The window's containment boundary: its main frame navigates only between its two documents, by navigation or by
 * redirect; it opens no windows; and a main-frame load failure of the UI shows the failure page. Subframes (the Code
 * Server workbench) navigate freely inside the UI's CSP. The UI's content security policy is the runtime's own
 * (`apps/runtime/src/web-ui/policy.ts`); the loader carries its policy in a meta tag. No log names a raw URL: the
 * loader's query carries its diagnostic.
 */
function installWindowContainment(window: BrowserWindow) {
  const isContained = (url: string) =>
    isAllowedWindowNavigation({ url, loaderBaseUrl: loaderBase, uiOrigin: uiOrigin ?? '' });

  window.webContents.on('will-navigate', (details) => {
    if (isContained(details.url)) return;
    details.preventDefault();
    console.info(
      `[desktop] denied window navigation to ${navigationDenialCoordinate(details.url)}`,
    );
  });

  // A navigation that starts at an allowed URL can still end elsewhere through a server redirect, which
  // `will-navigate` never sees. Only the main frame: the editor frame's own redirects stay its business.
  window.webContents.on('will-redirect', (details) => {
    if (!details.isMainFrame || isContained(details.url)) return;
    details.preventDefault();
    console.info(`[desktop] denied window redirect to ${navigationDenialCoordinate(details.url)}`);
  });

  // A `beforeunload` guard in the UI (the editor's unsaved-changes prompt, say) can veto main's navigation. Main
  // navigates away from the UI only to the loader, and only because the runtime or its page failed: what the guard
  // protects can no longer reach the runtime, and the user must see the failure, so the veto is overridden then. Any
  // other unload (a reload the UI started) keeps its guard.
  window.webContents.on('will-prevent-unload', (event) => {
    if (windowContent(runtimeStatus, pageFailure).kind !== 'loader') return;
    event.preventDefault();
    console.warn(
      '[desktop] overrode the page unload guard to show the failure page; unsaved editor changes could not reach the runtime',
    );
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    console.info(`[desktop] denied window open for ${navigationDenialCoordinate(url)}`);
    return { action: 'deny' };
  });

  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (uiOrigin === undefined || pageFailure) return;
      const failure = pageLoadFailure({
        errorCode,
        errorDescription,
        url: validatedURL,
        isMainFrame,
        uiOrigin,
      });
      if (!failure) return;
      console.error(`[desktop] the UI page failed to load: ${failure.message}`);
      pageFailure = failure;
      void showWindowContent(window);
    },
  );
}

/**
 * Loads what the current status calls for into `window`: the loader in its state, or the UI. A status that maps to the
 * document already shown loads nothing; a render overtaken by a newer one while it waited for the UI URL is dropped.
 */
async function showWindowContent(window: BrowserWindow) {
  const generation = ++renderGeneration;
  const content = windowContent(runtimeStatus, pageFailure);
  const target =
    content.kind === 'loader' ? loaderUrl(loaderBase, theme, content.loader) : await resolveUiUrl();
  if (generation !== renderGeneration || window.isDestroyed() || exitRequested) return;
  if (target === undefined || target === shownUrl) return;
  shownUrl = target;
  console.info(
    content.kind === 'loader'
      ? `[desktop] showing the loader: ${content.loader.state === 'failed' ? `failed (${content.loader.reason})` : content.loader.state}`
      : `[desktop] showing the UI from ${navigationDenialCoordinate(target)}`,
  );
  // `shownUrl` is what was requested, not yet what is displayed: a load that does not complete forgets it, so the next
  // render (any status change) asks again rather than believing the window already shows it. A load another render
  // superseded (ERR_ABORTED, newer generation) leaves the newer request alone; a real UI failure also arrives through
  // `did-fail-load`.
  window.loadURL(target).catch((error: unknown) => {
    const code = String((error as { code?: unknown }).code ?? 'unknown');
    if (generation !== renderGeneration) return;
    if (shownUrl === target) shownUrl = undefined;
    console.warn(
      `[desktop] load of ${navigationDenialCoordinate(target)} did not complete: ${code}`,
    );
  });
}

/**
 * The UI document's URL once the runtime is ready: the runtime's own URL, or in development the Vite dev server's
 * (after it answers). A dev server that never answers is a page load failure, and returns `undefined` after
 * re-rendering the failure page.
 */
async function resolveUiUrl(): Promise<string | undefined> {
  if (mode.kind === 'development') {
    uiOrigin = developmentOrigin;
    const waited = await desktop.runPromiseExit(waitForWebServer(mode.webUrl));
    if (Exit.isFailure(waited)) {
      if (exitRequested || Cause.hasInterruptsOnly(waited.cause)) return undefined;
      pageFailure = {
        message: `The development web server did not answer · ${developmentOrigin ?? 'ISAGI_WEB_URL'}`,
      };
      if (mainWindow) void showWindowContent(mainWindow);
      return undefined;
    }
    return mode.webUrl;
  }
  const url = await runDesktop(RuntimeProcess.use((runtimeProcess) => runtimeProcess.url)).catch(
    () => undefined,
  );
  if (url === undefined) return undefined;
  uiOrigin = new URL(url).origin;
  return url;
}

function startRuntime() {
  runtimeStartPromise ??= desktop
    .runPromiseExit(RuntimeProcess.use((runtimeProcess) => runtimeProcess.start))
    .then((exit) => {
      // Shutdown interrupts a start still in flight; that is not a failure to report. A failed start is shown by the
      // window (the status stream), and logged by the desktop layer.
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
        console.error(Cause.pretty(exit.cause));
      }
    });
  return runtimeStartPromise;
}

/** The UI's documents, from its origin; the update and host-chrome channels serve only them. */
const senderIsUi = (url: string) => uiOrigin !== undefined && isUiDocument(url, uiOrigin);
/** The loader, in any state; Open logs serves only it. */
const senderIsLoader = (url: string) => isLoaderDocument(url, loaderBase);
/** Either document; Quit serves both (the loader's failure page and the UI's `config_invalid` view). */
const senderIsWindowDocument = (url: string) => senderIsUi(url) || senderIsLoader(url);

ipcMain.handle('isagi:desktop-update', (event) => {
  assertAuthorizedIpcSender(mainWindow, event, senderIsUi);
  return runDesktop(DesktopUpdater.use((updater) => SubscriptionRef.get(updater.status)));
});

ipcMain.handle('isagi:desktop-update-intent', async (event, payload: unknown) => {
  assertAuthorizedIpcSender(mainWindow, event, senderIsUi);
  const intent = decodeDesktopUpdateIntent(payload);
  // Confirming a restart hands the process to the installer, whose shutdown disposes the runtime under this intent.
  await runDesktop(
    dispatchDesktopUpdateIntent(intent, { openExternal: (url) => shell.openExternal(url) }),
  );
});

ipcMain.handle('isagi:host-chrome-visible', (event, visible: unknown) => {
  assertAuthorizedIpcSender(mainWindow, event, senderIsUi);
  console.info(`[desktop] host-chrome visible=${String(visible)} (mac=${String(isMac)})`);
  if (!isMac) return;
  const shouldShow = visible === true;
  mainWindow?.setWindowButtonVisibility(shouldShow);
  mainWindow?.setWindowButtonPosition(
    shouldShow ? TRAFFIC_LIGHT_POSITION : HIDDEN_TRAFFIC_LIGHT_POSITION,
  );
});

ipcMain.handle('isagi:quit-app', async (event) => {
  assertAuthorizedIpcSender(mainWindow, event, senderIsWindowDocument);
  console.info('[desktop] quit requested by the window');
  await requestExit({ code: 0 });
});

ipcMain.handle('isagi:open-logs', async (event) => {
  assertAuthorizedIpcSender(mainWindow, event, senderIsLoader);
  const logsDirectory = app.getPath('logs');
  // `openPath` resolves with an error message rather than rejecting.
  const failure = await shell.openPath(logsDirectory);
  if (failure) console.warn(`[desktop] could not open the logs directory: ${failure}`);
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
      // included) and the window bridge subscribes, both before the window exists. A
      // runtime status published before the window exists is kept and shown when it
      // opens; an update snapshot is reconciled when the renderer subscribes.
      build: async () => {
        updaterInstaller = await runDesktop(DesktopUpdater.useSync((updater) => updater.installer));
      },
      openWindow: async () => createWindow(),
    });
  })
  .catch((error: unknown) => {
    console.error(error);
    void requestExit({ code: 1 });
  });

// A window recreated here (macOS) shows the current status: the loader, the UI, or the failure page.
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
