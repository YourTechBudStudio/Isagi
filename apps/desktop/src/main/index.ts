import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
import { app, BrowserWindow, ipcMain } from 'electron';

import { waitForRuntimeHealth, waitForWebServer } from './boot.js';
import { getRuntimeUrl, stopRuntime } from './runtime.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
let runtimeUrl = '';

function createWindow() {
  return Effect.runPromise(createWindowEffect());
}

function createWindowEffect() {
  return Effect.gen(function* () {
    const window = new BrowserWindow({
      backgroundColor: '#24273a',
      height: 900,
      minHeight: 600,
      minWidth: 900,
      show: false,
      title: 'Isagi',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(currentDirectory, '../preload/index.js'),
      },
      width: 1280,
    });

    window.once('ready-to-show', () => {
      window.show();
    });

    yield* loadFile(window, getSplashPath());
    yield* runBootSequence(window);
  });
}

function runBootSequence(window: BrowserWindow) {
  return Effect.gen(function* () {
    yield* setBootStatus(window, 'Starting runtime...', 'Resolving local or remote runtime.');
    runtimeUrl = yield* getRuntimeUrl();

    yield* setBootStatus(window, 'Checking runtime...', runtimeUrl);
    yield* waitForRuntimeHealth(runtimeUrl);

    if (app.isPackaged) {
      yield* setBootStatus(window, 'Loading app...', 'Opening packaged renderer.');
      yield* loadFile(window, join(process.resourcesPath, 'web/index.html'));
      return;
    }

    const webUrl = process.env.ISAGI_WEB_URL ?? 'http://127.0.0.1:5173';

    yield* setBootStatus(window, 'Waiting for web renderer...', webUrl);
    yield* waitForWebServer(webUrl);

    yield* setBootStatus(window, 'Loading app...', webUrl);
    yield* tryPromise(() => window.loadURL(webUrl));
  }).pipe(
    Effect.catchAll((error) =>
      setBootStatus(window, 'Could not start Isagi.', error.message, 'failed'),
    ),
  );
}

function setBootStatus(
  window: BrowserWindow,
  message: string,
  detail?: string,
  state: 'booting' | 'failed' = 'booting',
) {
  return tryPromise(() =>
    window.webContents.executeJavaScript(
      `window.setBootStatus?.(${JSON.stringify({ detail, message, state })})`,
    ),
  );
}

function loadFile(window: BrowserWindow, path: string) {
  return tryPromise(() => window.loadFile(path));
}

function getSplashPath() {
  return join(currentDirectory, '../../static/splash.html');
}

function tryPromise<T>(run: () => Promise<T>) {
  return Effect.tryPromise({
    try: run,
    catch: toError,
  });
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

ipcMain.handle('isagi:runtime-url', () => runtimeUrl);

app.once('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.once('before-quit', () => {
  stopRuntime();
});

app
  .whenReady()
  .then(createWindow)
  .catch((error: unknown) => {
    console.error(error);
    app.quit();
  });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
