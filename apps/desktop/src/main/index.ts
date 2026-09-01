import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Cause, Effect, Exit } from 'effect';
import { app, BrowserWindow, ipcMain, shell } from 'electron';

import { developmentEnvironmentKeys } from '../../../../scripts/dev-supervisor/dev-protocol.mjs';
import { waitForWebServer } from './boot.js';
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
import { createRuntimeLifecycle } from './runtime.js';
import { DesktopShutdownCoordinator, handleBeforeQuit } from './shutdown.js';
import {
  composeDesktopUpdater,
  decodeDesktopUpdateIntent,
  dispatchDesktopUpdateIntent,
  type DesktopUpdaterService,
} from './updater/index.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const APP_ID = 'studio.yourtechbud.isagi';
const DEVELOPMENT_ICON_PATH = join(
  currentDirectory,
  `../../assets/${process.platform === 'darwin' ? 'app-icon.png' : 'app-icon-linux.png'}`,
);
const TRAFFIC_LIGHT_POSITION = { x: 18, y: 18 };
const HIDDEN_TRAFFIC_LIGHT_POSITION = { x: -100, y: -100 };
const RUNTIME_STATUS_CHANNEL = 'isagi:runtime-status-changed';
const DESKTOP_UPDATE_CHANNEL = 'isagi:desktop-update-changed';
const isMac = process.platform === 'darwin';
const isDev = !app.isPackaged;
const desktopRoot = join(currentDirectory, '../..');
const repositoryRoot = join(desktopRoot, '../..');

app.setAppUserModelId(APP_ID);
if (isDev) configureDevelopmentUserData(repositoryRoot);

const runtimeLifecycle = createRuntimeLifecycle();
let mainWindow: BrowserWindow | undefined;
let runtimeStartPromise: Promise<void> | undefined;
let exitRequested = false;
let desktopUpdater: DesktopUpdaterService | undefined;
let unsubscribeDesktopUpdate: (() => void) | undefined;
const shutdown = new DesktopShutdownCoordinator({
  desktopUpdater: () => desktopUpdater,
  runtimeLifecycle,
  destroyRenderer: () => {
    exitRequested = true;
    // Nothing can receive a snapshot past this point, and the installing state
    // the renderer last saw is the honest final one.
    unsubscribeDesktopUpdate?.();
    unsubscribeDesktopUpdate = undefined;
    destroyRendererForExit(mainWindow);
  },
  exit: (code) => app.exit(code),
  diagnoseInstallRejection: () => desktopUpdater?.recordInstallRejection(),
});

runtimeLifecycle.subscribe((snapshot) => {
  if (snapshot.state === 'failed') {
    console.error('[desktop] Managed runtime failed', {
      reason: snapshot.reason,
      diagnostic: snapshot.diagnostic,
    });
    void preservePackagedRuntimeFailure(snapshot).finally(() => requestExit({ code: 1 }));
    return;
  }
  publishRuntimeStatus(snapshot);
});

async function preservePackagedRuntimeFailure(
  snapshot: Extract<typeof runtimeLifecycle.snapshot, { readonly state: 'failed' }>,
) {
  if (!app.isPackaged) return;
  const logDirectory = app.getPath('logs');
  const logPath = join(logDirectory, 'managed-runtime-failure.json');
  try {
    await mkdir(logDirectory, { recursive: true });
    await writeFile(
      logPath,
      `${JSON.stringify({ recordedAt: new Date().toISOString(), ...snapshot }, null, 2)}\n`,
      'utf8',
    );
    console.error(`[desktop] Managed runtime failure record written to ${logPath}`);
  } catch (error) {
    console.error(
      `[desktop] Failed to preserve managed runtime failure record at ${logPath}`,
      error,
    );
  }
}

function createWindow() {
  return Effect.runPromise(createWindowEffect());
}

function createWindowEffect() {
  return Effect.gen(function* () {
    console.info(
      `[desktop] creating Isagi window: mode=${isDev ? 'dev' : 'packaged'} chrome=${
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
  runtimeStartPromise ??= Effect.runPromiseExit(runtimeLifecycle.start()).then((exit) => {
    if (Exit.isFailure(exit)) {
      console.error(Cause.pretty(exit.cause, { renderErrorCause: true }));
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

function publishRuntimeStatus(snapshot: typeof runtimeLifecycle.snapshot) {
  send(RUNTIME_STATUS_CHANNEL, snapshot);
}

function send(channel: string, payload: unknown) {
  const webContents = mainWindow?.webContents;
  if (!webContents || webContents.isDestroyed()) return;
  webContents.send(channel, payload);
}

ipcMain.handle('isagi:runtime-url', (event) => {
  assertAuthorizedIpcSender(mainWindow, event);
  return resolveRuntimeUrlForIpc(
    () => Effect.runPromise(runtimeLifecycle.getUrl()),
    () => exitRequested,
  );
});

ipcMain.handle('isagi:runtime-status', (event) => {
  assertAuthorizedIpcSender(mainWindow, event);
  return runtimeLifecycle.snapshot;
});

ipcMain.handle('isagi:desktop-update', (event) => {
  assertAuthorizedIpcSender(mainWindow, event);
  return desktopUpdater?.snapshot;
});

ipcMain.handle('isagi:desktop-update-intent', async (event, payload: unknown) => {
  assertAuthorizedIpcSender(mainWindow, event);
  const updater = desktopUpdater;
  if (!updater) return;
  await dispatchDesktopUpdateIntent(decodeDesktopUpdateIntent(payload), {
    service: updater,
    openExternal: (url) => shell.openExternal(url),
  });
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
    desktopUpdater = await composeDesktopUpdater(app, {
      getRuntimeUrl: () => runtimeLifecycle.getUrl(),
      isExitCommitted: () => shutdown.committed,
      requestInstall: () => {
        const updater = desktopUpdater;
        if (!updater) return;
        void shutdown.request({ kind: 'install_update', install: () => updater.quitAndInstall() });
      },
    });
    // One subscription for the process, established before the window exists.
    // A snapshot published before the renderer can listen is not lost: the
    // renderer reconciles the current snapshot when it subscribes.
    unsubscribeDesktopUpdate = desktopUpdater.subscribe((snapshot) =>
      send(DESKTOP_UPDATE_CHANNEL, snapshot),
    );
    await Effect.runPromise(desktopUpdater.start());
    return createWindow();
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
