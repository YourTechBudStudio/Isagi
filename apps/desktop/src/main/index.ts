import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Cause, Effect, Exit } from 'effect';
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { waitForWebServer } from './boot.js';
import { createRuntimeLifecycle } from './runtime.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const APP_ID = 'studio.yourtechbud.isagi';
const DEVELOPMENT_ICON_PATH = join(currentDirectory, '../../assets/app-icon.png');
const TRAFFIC_LIGHT_POSITION = { x: 18, y: 18 };
const HIDDEN_TRAFFIC_LIGHT_POSITION = { x: -100, y: -100 };
const RUNTIME_STATUS_CHANNEL = 'isagi:runtime-status-changed';
const isMac = process.platform === 'darwin';
const isDev = !app.isPackaged;

app.setAppUserModelId(APP_ID);

const runtimeLifecycle = createRuntimeLifecycle();
let mainWindow: BrowserWindow | undefined;
let exitPromise: Promise<void> | undefined;
let pendingExitOptions: { code: number; relaunch: boolean } | undefined;

runtimeLifecycle.subscribe((snapshot) => {
  if (snapshot.state === 'failed') {
    console.error('[desktop] Managed runtime failed', {
      reason: snapshot.reason,
      diagnostic: snapshot.diagnostic,
    });
    if (isDev) {
      void requestExit({ code: 1 });
      return;
    }
  }
  publishRuntimeStatus(snapshot);
});

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

    const startExit = yield* Effect.exit(runtimeLifecycle.start());
    if (Exit.isFailure(startExit)) {
      if (isDev) return yield* Effect.failCause(startExit.cause);
      console.error(Cause.pretty(startExit.cause, { renderErrorCause: true }));
    }

    yield* loadRenderer(window);
  });
}

function loadRenderer(window: BrowserWindow) {
  if (app.isPackaged) return loadFile(window, join(process.resourcesPath, 'web/index.html'));
  const webUrl = process.env.ISAGI_WEB_URL;
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
  const webContents = mainWindow?.webContents;
  if (!webContents || webContents.isDestroyed()) return;
  webContents.send(RUNTIME_STATUS_CHANNEL, snapshot);
}

function assertAuthorizedSender(event: IpcMainInvokeEvent) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('IPC request did not originate from the active Isagi window.');
  }
}

ipcMain.handle('isagi:runtime-url', (event) => {
  assertAuthorizedSender(event);
  return Effect.runPromise(runtimeLifecycle.getUrl());
});

ipcMain.handle('isagi:runtime-status', (event) => {
  assertAuthorizedSender(event);
  return runtimeLifecycle.snapshot;
});

ipcMain.handle('isagi:host-chrome-visible', (event, visible: unknown) => {
  assertAuthorizedSender(event);
  console.info(`[desktop] host-chrome visible=${String(visible)} (mac=${String(isMac)})`);
  if (!isMac) return;
  const shouldShow = visible === true;
  mainWindow?.setWindowButtonVisibility(shouldShow);
  mainWindow?.setWindowButtonPosition(
    shouldShow ? TRAFFIC_LIGHT_POSITION : HIDDEN_TRAFFIC_LIGHT_POSITION,
  );
});

ipcMain.handle('isagi:relaunch-app', async (event) => {
  assertAuthorizedSender(event);
  console.info('[desktop] full app relaunch requested by renderer');
  await requestExit({ code: 0, relaunch: true });
});

ipcMain.handle('isagi:quit-app', async (event) => {
  assertAuthorizedSender(event);
  console.info('[desktop] quit requested by renderer');
  await requestExit({ code: 0 });
});

function requestExit(options: { readonly code: number; readonly relaunch?: boolean }) {
  pendingExitOptions = {
    code:
      pendingExitOptions && pendingExitOptions.code !== 0 ? pendingExitOptions.code : options.code,
    relaunch: (pendingExitOptions?.relaunch ?? false) || options.relaunch === true,
  };
  exitPromise ??= Effect.runPromise(runtimeLifecycle.stop()).then(() => {
    if (!pendingExitOptions) return;
    if (pendingExitOptions.relaunch) app.relaunch();
    app.exit(pendingExitOptions.code);
  });
  return exitPromise;
}

app.on('window-all-closed', () => {
  if (isDev || process.platform !== 'darwin') void requestExit({ code: 0 });
});

app.on('before-quit', (event) => {
  event.preventDefault();
  if (!exitPromise) void requestExit({ code: 0 });
});

process.once('SIGINT', () => void requestExit({ code: 130 }));
process.once('SIGTERM', () => void requestExit({ code: 143 }));

app
  .whenReady()
  .then(() => {
    if (isDev && app.dock) app.dock.setIcon(DEVELOPMENT_ICON_PATH);
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
