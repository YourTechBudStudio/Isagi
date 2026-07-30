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
        preload: join(currentDirectory, '../preload/index.js'),
      },
      width: 1280,
    });
    mainWindow = window;
    window.once('closed', () => {
      if (mainWindow === window) mainWindow = undefined;
    });
    window.once('ready-to-show', () => window.show());

    startRuntime();
    yield* loadRenderer(window);
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

function loadRenderer(window: BrowserWindow) {
  if (app.isPackaged) return loadFile(window, join(process.resourcesPath, 'web/index.html'));
  const webUrl = process.env[developmentEnvironmentKeys.webUrl];
  if (!webUrl) return Effect.fail(new Error('Desktop development requires ISAGI_WEB_URL.'));
  return Effect.gen(function* () {
    yield* waitForWebServer(webUrl);
    yield* tryPromise(() => window.loadURL(webUrl));
  });
}

function loadFile(window: BrowserWindow, path: string) {
  return tryPromise(() => window.loadFile(path));
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
